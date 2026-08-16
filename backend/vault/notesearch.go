package vault

import (
	"fmt"
	"sort"
	"strings"
	"unicode"
)

// Buscador de la base de conocimiento.
//
// Un `LIKE %texto%` no sirve para buscar en documentación propia, y no por
// lentitud: no encuentra "diagnóstico" cuando uno escribe "diagnostico", no
// distingue un acierto en el título de uno perdido en el pie de página, no
// sabe qué hacer con dos palabras sueltas, y devuelve una lista de títulos sin
// decir POR QUÉ apareció cada uno. Buscar algo en la propia documentación es
// justamente el momento en el que uno no recuerda el título — si recordara el
// título no estaría buscando.
//
// Entonces este buscador hace cuatro cosas:
//
//  1. **Normaliza acentos y mayúsculas.** "diagnostico" encuentra
//     "Diagnóstico"; escribir con tildes en un buscador es una fricción que
//     nadie debería pagar.
//  2. **Varios términos, en cualquier orden, todos obligatorios.** "oracle
//     tablespace" encuentra la nota que habla de los dos aunque estén en
//     párrafos distintos, y no la que habla solo de Oracle.
//  3. **Ordena por relevancia**, no por fecha: el título pesa más que el
//     cuerpo, la frase exacta más que los términos sueltos, y varias
//     apariciones más que una. La fecha desempata.
//  4. **Devuelve el fragmento donde acertó**, con las posiciones marcadas, para
//     que la lista muestre el contexto en vez de obligar a abrir cada
//     resultado para ver si era esa.
//
// **Todo esto corre en memoria, descifrando.** No hay ningún índice
// persistido, y no es una omisión: un índice de texto sobre contenido cifrado
// guarda algo derivado del texto plano —tokens, hashes de palabra— y eso es un
// canal lateral, con el que se puede preguntar "¿esta nota contiene tal
// palabra?" sin tener la clave. A escala de notas personales la diferencia de
// velocidad no se percibe; el agujero sí se aprovecha.

// NoteHit es un resultado con su porqué.
type NoteHit struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	IsPrivate bool   `json:"isPrivate"`
	UpdatedAt int64  `json:"updatedAt"`
	// Score es la relevancia calculada. Se devuelve para poder depurar el
	// ranking desde la interfaz, no para mostrarlo como un número.
	Score int `json:"score"`
	// Snippet es el fragmento del cuerpo donde acertó, con los términos
	// resaltados por `«…»`. Vacío cuando el acierto fue solo en el título.
	Snippet string `json:"snippet"`
	// MatchedTitle indica que el título acertó, para que la lista lo marque.
	MatchedTitle bool `json:"matchedTitle"`
	// FolderID es la carpeta donde vive, para poder dibujar el árbol con los
	// resultados de una búsqueda en su lugar.
	FolderID string `json:"folderId"`
}

// NoteQuery es una consulta ya parseada.
type NoteQuery struct {
	// Terms son las palabras sueltas: TODAS tienen que aparecer.
	Terms []string
	// Phrases son los tramos entre comillas: tienen que aparecer literales.
	Phrases []string
	// Tags son los filtros `tag:algo`, que se buscan en el frontmatter.
	Tags []string
	// OnlyPrivate/OnlyShared vienen de `privado:si` / `privado:no`. Es el
	// filtro que contesta "¿qué de todo esto puede leer un agente?", que es
	// una pregunta que conviene poder hacerse.
	OnlyPrivate bool
	OnlyShared  bool
	// LinksTo filtra por `enlaza:Título`: las notas que apuntan a esa.
	LinksTo string
}

// ParseNoteQuery entiende la caja de búsqueda.
//
// Tolerante como el resto de los parsers del proyecto: un filtro mal escrito
// se trata como un término más en vez de rechazar la búsqueda entera. Quien
// escribe `tag:` a medias está por terminar de escribirlo, no cometiendo un
// error.
func ParseNoteQuery(raw string) NoteQuery {
	var q NoteQuery
	for _, tok := range splitQuoted(raw) {
		if tok.quoted {
			if t := strings.TrimSpace(tok.text); t != "" {
				q.Phrases = append(q.Phrases, foldText(t))
			}
			continue
		}
		for _, w := range strings.Fields(tok.text) {
			lower := strings.ToLower(w)
			switch {
			case strings.HasPrefix(lower, "tag:") && len(w) > 4:
				q.Tags = append(q.Tags, foldText(w[4:]))
			case strings.HasPrefix(lower, "enlaza:") && len(w) > 7:
				q.LinksTo = w[7:]
			case lower == "privado:si" || lower == "privado:sí":
				q.OnlyPrivate = true
			case lower == "privado:no":
				q.OnlyShared = true
			default:
				if f := foldText(w); f != "" {
					q.Terms = append(q.Terms, f)
				}
			}
		}
	}
	return q
}

type queryToken struct {
	text   string
	quoted bool
}

func splitQuoted(s string) []queryToken {
	var out []queryToken
	var cur strings.Builder
	inQuote := false
	for _, r := range s {
		if r == '"' {
			out = append(out, queryToken{text: cur.String(), quoted: inQuote})
			cur.Reset()
			inQuote = !inQuote
			continue
		}
		cur.WriteRune(r)
	}
	// Una comilla sin cerrar cierra al final: lo escrito hasta ahí igual sirve
	// como frase, y negarse a buscar hasta que la cierren sería inútilmente
	// estricto con alguien que está escribiendo.
	out = append(out, queryToken{text: cur.String(), quoted: inQuote})
	return out
}

// accentFolds son los reemplazos de acentos que importan en castellano (y los
// de las otras lenguas latinas que aparecen en documentación técnica).
//
// Escrito a mano en vez de sumar `golang.org/x/text`: son doce runas y la
// alternativa es una dependencia nueva por una tabla — la misma decisión que
// el frontmatter y el TOML de este proyecto (regla 12).
var accentFolds = map[rune]rune{
	'á': 'a', 'à': 'a', 'ä': 'a', 'â': 'a', 'ã': 'a', 'å': 'a',
	'é': 'e', 'è': 'e', 'ë': 'e', 'ê': 'e',
	'í': 'i', 'ì': 'i', 'ï': 'i', 'î': 'i',
	'ó': 'o', 'ò': 'o', 'ö': 'o', 'ô': 'o', 'õ': 'o',
	'ú': 'u', 'ù': 'u', 'ü': 'u', 'û': 'u',
	'ñ': 'n', 'ç': 'c',
}

// foldText normaliza para comparar: minúsculas y sin acentos.
func foldText(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range strings.ToLower(s) {
		if f, ok := accentFolds[r]; ok {
			b.WriteRune(f)
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

// Pesos del ranking. Son números elegidos a mano, no aprendidos: el orden
// relativo es lo que importa —el título pesa mucho más que el cuerpo, la frase
// exacta más que los términos sueltos— y el valor absoluto no significa nada.
const (
	scoreTitleExact    = 500
	scoreTitleTerm     = 120
	scorePhraseBody    = 60
	scoreBodyTerm      = 10
	scoreBodyRepeat    = 3
	scoreTagMatch      = 80
	maxBodyOccurrences = 8
)

// SearchNotesSmart busca en la base de conocimiento y devuelve los resultados
// ordenados por relevancia, con su fragmento.
func (s *Store) SearchNotesSmart(raw string, limit int) ([]NoteHit, error) {
	if limit <= 0 {
		limit = 40
	}
	q := ParseNoteQuery(raw)
	if len(q.Terms) == 0 && len(q.Phrases) == 0 && len(q.Tags) == 0 && q.LinksTo == "" && !q.OnlyPrivate && !q.OnlyShared {
		// Sin nada que buscar, la lista completa por fecha es la respuesta
		// correcta: es la pantalla de "todas mis notas".
		list, err := s.ListNotes()
		if err != nil {
			return nil, err
		}
		out := make([]NoteHit, 0, len(list))
		for i, n := range list {
			if i >= limit {
				break
			}
			out = append(out, NoteHit{ID: n.ID, Title: n.Title, IsPrivate: n.IsPrivate, UpdatedAt: n.UpdatedAt})
		}
		return out, nil
	}

	// El filtro `enlaza:` se resuelve contra el índice de aristas, que ya está
	// hecho para eso — recorrer los cuerpos buscando `[[X]]` sería reimplementar
	// el grafo a mano en cada búsqueda.
	var linkedFrom map[string]bool
	if q.LinksTo != "" {
		linkedFrom = map[string]bool{}
		rows, err := s.db.Query(`SELECT source_note_id FROM vault_note_links WHERE target_title_hash = ?`, TitleHash(q.LinksTo))
		if err != nil {
			return nil, fmt.Errorf("vault: filtrando por enlaces: %w", err)
		}
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err == nil {
				linkedFrom[id] = true
			}
		}
		rows.Close()
	}

	rows, err := s.db.Query(
		`SELECT id, encrypted_title, title_nonce, encrypted_content, content_nonce,
		        encrypted_frontmatter, frontmatter_nonce, is_private, updated_at
		        , COALESCE(folder_id, '')
		 FROM vault_notes`)
	if err != nil {
		return nil, fmt.Errorf("vault: buscando en las notas: %w", err)
	}
	defer rows.Close()

	var hits []NoteHit
	for rows.Next() {
		var id string
		var encTitle, titleNonce, encContent, contentNonce, encFm, fmNonce []byte
		var private int
		var updated int64
		var folderID string
		if err := rows.Scan(&id, &encTitle, &titleNonce, &encContent, &contentNonce,
			&encFm, &fmNonce, &private, &updated, &folderID); err != nil {
			return nil, err
		}

		if q.OnlyPrivate && private == 0 {
			continue
		}
		if q.OnlyShared && private != 0 {
			continue
		}
		if linkedFrom != nil && !linkedFrom[id] {
			continue
		}

		title := s.decryptOptional(encTitle, titleNonce)
		content := s.decryptOptional(encContent, contentNonce)
		frontmatter := s.decryptOptional(encFm, fmNonce)

		hit, ok := scoreNote(q, id, title, content, frontmatter)
		if !ok {
			continue
		}
		hit.IsPrivate = private != 0
		hit.UpdatedAt = updated
		hit.FolderID = folderID
		hits = append(hits, hit)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	sort.SliceStable(hits, func(i, j int) bool {
		if hits[i].Score != hits[j].Score {
			return hits[i].Score > hits[j].Score
		}
		// A igual relevancia, la más reciente: en documentación propia lo
		// último que tocaste suele ser lo que estabas buscando.
		return hits[i].UpdatedAt > hits[j].UpdatedAt
	})
	if len(hits) > limit {
		hits = hits[:limit]
	}
	if hits == nil {
		hits = []NoteHit{}
	}
	return hits, nil
}

// scoreNote decide si una nota entra y con cuánto peso.
//
// **Todos los términos son obligatorios.** Buscar "oracle tablespace" y que
// aparezca la nota que solo habla de Oracle convierte el buscador en una lista
// de todo lo que alguna vez mencionó una palabra común.
func scoreNote(q NoteQuery, id, title, content, frontmatter string) (NoteHit, bool) {
	foldedTitle := foldText(title)
	foldedBody := foldText(content)
	foldedFm := foldText(frontmatter)

	for _, tag := range q.Tags {
		if !strings.Contains(foldedFm, tag) {
			return NoteHit{}, false
		}
	}

	score := 0
	if len(q.Tags) > 0 {
		score += scoreTagMatch * len(q.Tags)
	}

	for _, phrase := range q.Phrases {
		switch {
		case strings.Contains(foldedTitle, phrase):
			score += scoreTitleExact
		case strings.Contains(foldedBody, phrase):
			score += scorePhraseBody
		default:
			return NoteHit{}, false
		}
	}

	matchedTitle := false
	for _, term := range q.Terms {
		inTitle := strings.Contains(foldedTitle, term)
		count := strings.Count(foldedBody, term)
		if !inTitle && count == 0 && !strings.Contains(foldedFm, term) {
			return NoteHit{}, false
		}
		if inTitle {
			matchedTitle = true
			score += scoreTitleTerm
			// El título completo, y no solo conteniéndolo, es la señal más
			// fuerte que hay: es quien buscó acordándose del nombre.
			if foldedTitle == term {
				score += scoreTitleExact
			}
		}
		if count > 0 {
			score += scoreBodyTerm
			if count > maxBodyOccurrences {
				count = maxBodyOccurrences
			}
			score += scoreBodyRepeat * (count - 1)
		}
	}

	hit := NoteHit{ID: id, Title: title, Score: score, MatchedTitle: matchedTitle}
	hit.Snippet = buildSnippet(content, foldedBody, q)
	return hit, true
}

// buildSnippet arma el fragmento alrededor del primer acierto en el cuerpo.
//
// Marcado con `«…»` y no con HTML: lo que sale de acá termina en un componente
// de React que **nunca** inyecta HTML (misma regla que MarkdownPreview), así
// que el resaltado se hace en la interfaz partiendo por esos marcadores.
func buildSnippet(content, foldedBody string, q NoteQuery) string {
	const window = 160

	needle := ""
	for _, p := range q.Phrases {
		needle = p
		break
	}
	if needle == "" {
		for _, t := range q.Terms {
			if strings.Contains(foldedBody, t) {
				needle = t
				break
			}
		}
	}
	if needle == "" {
		return ""
	}

	// El índice se calcula sobre el texto plegado, que tiene el MISMO largo en
	// bytes que el original solo si el plegado no cambió el ancho de ninguna
	// runa — y sí lo cambia (á son 2 bytes, a es 1). Así que se localiza por
	// runas y se corta por runas.
	idx := strings.Index(foldedBody, needle)
	if idx < 0 {
		return ""
	}
	runeStart := len([]rune(foldedBody[:idx]))
	runes := []rune(content)
	if runeStart > len(runes) {
		return ""
	}
	needleLen := len([]rune(needle))

	from := runeStart - window/2
	if from < 0 {
		from = 0
	}
	to := runeStart + needleLen + window/2
	if to > len(runes) {
		to = len(runes)
	}

	var b strings.Builder
	if from > 0 {
		b.WriteString("…")
	}
	b.WriteString(strings.TrimSpace(collapseSpace(string(runes[from:runeStart]))))
	b.WriteString(" «")
	b.WriteString(string(runes[runeStart : runeStart+needleLen]))
	b.WriteString("» ")
	b.WriteString(strings.TrimSpace(collapseSpace(string(runes[runeStart+needleLen : to]))))
	if to < len(runes) {
		b.WriteString("…")
	}
	return b.String()
}

// collapseSpace deja el fragmento en una sola línea: un snippet con saltos de
// línea rompe la altura de la fila y hace saltar la lista mientras se escribe.
func collapseSpace(s string) string {
	var b strings.Builder
	space := false
	for _, r := range s {
		if unicode.IsSpace(r) {
			space = true
			continue
		}
		if space && b.Len() > 0 {
			b.WriteByte(' ')
		}
		space = false
		b.WriteRune(r)
	}
	return b.String()
}

// AllNoteTags junta las etiquetas (`#algo`) de todas las notas, con cuántas
// veces aparece cada una.
//
// **Sirve para autocompletar.** Es el mismo principio que el autocompletado de
// SQL: no se inventan sugerencias, se ofrecen las que ya existen en tus datos.
// Escribir `#prod` y que aparezca `#produccion` porque ya la usaste en otras
// cuatro notas es lo que evita terminar con `#produccion`, `#produccion-`,
// `#prod` y `#PROD` como cuatro etiquetas distintas.
//
// Descifra en memoria, como el buscador, y por el mismo motivo: un índice de
// etiquetas persistido sería contenido derivado del texto plano.
func (s *Store) AllNoteTags() ([]NoteTag, error) {
	rows, err := s.db.Query(`SELECT encrypted_content, content_nonce, encrypted_frontmatter, frontmatter_nonce FROM vault_notes`)
	if err != nil {
		return nil, fmt.Errorf("vault: leyendo las etiquetas: %w", err)
	}
	defer rows.Close()

	counts := map[string]int{}
	for rows.Next() {
		var encContent, contentNonce, encFm, fmNonce []byte
		if err := rows.Scan(&encContent, &contentNonce, &encFm, &fmNonce); err != nil {
			return nil, err
		}
		text := s.decryptOptional(encContent, contentNonce) + "\n" + s.decryptOptional(encFm, fmNonce)
		for _, tag := range extractTags(text) {
			counts[tag]++
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	out := make([]NoteTag, 0, len(counts))
	for tag, n := range counts {
		out = append(out, NoteTag{Tag: tag, Count: n})
	}
	// Las más usadas primero: son las que uno quiere volver a usar.
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].Tag < out[j].Tag
	})
	return out, nil
}

// NoteTag es una etiqueta con cuántas notas la usan.
type NoteTag struct {
	Tag   string `json:"tag"`
	Count int    `json:"count"`
}

// extractTags saca las etiquetas de un texto.
//
// Una etiqueta es `#` pegado a una palabra; `# ` con espacio es un encabezado y
// no cuenta. Esa diferencia de un carácter es la que confunde a todo el mundo,
// así que está escrita en los dos lados que la miran (acá y en el editor).
func extractTags(text string) []string {
	var out []string
	seen := map[string]bool{}
	for _, line := range strings.Split(text, "\n") {
		trimmed := strings.TrimLeft(line, " \t")
		// Encabezado: `#` seguido de espacio (o de más almohadillas y espacio).
		if h := strings.TrimLeft(trimmed, "#"); h != trimmed && strings.HasPrefix(h, " ") {
			continue
		}
		for i := 0; i < len(line); i++ {
			if line[i] != '#' {
				continue
			}
			if i > 0 && !isTagBoundary(line[i-1]) {
				continue
			}
			j := i + 1
			for j < len(line) && isTagRune(line[j]) {
				j++
			}
			if j == i+1 {
				continue
			}
			tag := line[i:j]
			if !seen[tag] {
				seen[tag] = true
				out = append(out, tag)
			}
			i = j
		}
	}
	return out
}

func isTagBoundary(b byte) bool { return b == ' ' || b == '\t' || b == '(' || b == '[' }

func isTagRune(b byte) bool {
	return b == '_' || b == '-' || b == '/' ||
		(b >= '0' && b <= '9') || (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') || b >= 0x80
}
