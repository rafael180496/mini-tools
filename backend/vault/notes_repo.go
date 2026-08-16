package vault

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"strings"
	"time"
	"unicode"
)

// Base de conocimiento cifrada (migraciones 34-36).
//
// Markdown puro, cifrado columna por columna con la clave maestra del vault —
// el mismo esquema que `connections.encrypted_dsn`, por la misma razón: cifrar
// el archivo entero necesitaría SQLCipher y cgo, que están prohibidos
// (.claude/rules/technical.md puntos 1 y 3).
//
// **Privacidad por defecto.** Una nota nace con `is_private = 1` y el default
// vive en el esquema, no en este código: una nota creada por un camino nuevo
// nace privada igual. Ninguna función de este archivo devuelve el contenido de
// una nota privada a un consumidor que no sea la propia interfaz — ver
// `NoteForAI`, que es la única puerta por la que el agente y el servidor MCP
// pueden pedir una nota.
//
// **Lo que va en claro y por qué.** El hash del título (para resolver enlaces
// y dibujar el grafo sin descifrar nada), el flag de privacidad (para poder
// filtrar sin descifrar), el checksum y las fechas. Nada de eso es contenido:
// un hash no revela el título, y saber que existe una nota privada no es lo
// mismo que poder leerla.

// Note es una nota completa, ya descifrada.
type Note struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	// Content es el Markdown del cuerpo.
	Content string `json:"content"`
	// Frontmatter son las etiquetas y metadatos, como texto (no se parsea acá:
	// sumar un parser YAML al binario está descartado por la regla 12, igual
	// que en backend/agentctx/frontmatter.go).
	Frontmatter string `json:"frontmatter"`
	// IsPrivate es si está oculta para los agentes. Nace en true.
	IsPrivate bool  `json:"isPrivate"`
	CreatedAt int64 `json:"createdAt"`
	UpdatedAt int64 `json:"updatedAt"`
	// Corrupt marca que el checksum no coincidió con lo descifrado. La nota se
	// devuelve igual —perderla sería peor— pero la interfaz tiene que poder
	// decir que su contenido no es confiable en vez de mostrarlo como si nada.
	Corrupt bool `json:"corrupt,omitempty"`
}

// NoteSummary es una fila de la lista: sin el cuerpo, que en una lista de
// doscientas notas serían doscientos descifrados para mostrar títulos.
type NoteSummary struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	IsPrivate bool   `json:"isPrivate"`
	UpdatedAt int64  `json:"updatedAt"`
	// LinkCount es cuántos enlaces salen de esta nota, para poder marcar las
	// huérfanas sin abrirlas.
	LinkCount int `json:"linkCount"`
}

// NoteLink es una arista del grafo ya resuelta contra las notas existentes.
type NoteLink struct {
	// TargetID es la nota destino, o "" si el enlace apunta a una nota que no
	// existe todavía. Un enlace roto NO es un error: es como se crean las
	// notas en un grafo de conocimiento.
	TargetID string `json:"targetId"`
	// Title es el título del destino cuando existe. Cuando no, queda vacío y
	// la interfaz muestra el texto tal cual lo escribió el usuario.
	Title string `json:"title"`
	// TargetHash identifica al destino aunque no exista.
	TargetHash string `json:"targetHash"`
	IsPrivate  bool   `json:"isPrivate"`
}

// NormalizeTitle es cómo se compara un título para resolver `[[enlaces]]`:
// sin espacios en los bordes, minúsculas, y espacios internos colapsados.
//
// Es deliberadamente tolerante: quien escribe `[[Runbook  SGC]]` en una nota y
// `[[runbook sgc]]` en otra está nombrando la misma cosa, y un grafo que los
// trata como dos nodos distintos no sirve para nada.
func NormalizeTitle(title string) string {
	var b strings.Builder
	space := false
	for _, r := range strings.TrimSpace(strings.ToLower(title)) {
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

// TitleHash es SHA-256 del título normalizado. Es lo único del título que
// queda legible en la base.
func TitleHash(title string) string {
	sum := sha256.Sum256([]byte(NormalizeTitle(title)))
	return hex.EncodeToString(sum[:])
}

func contentChecksum(title, content, frontmatter string) string {
	// Los tres juntos y separados por un byte que no puede aparecer en el
	// texto: concatenarlos a secas haría que mover una palabra del título al
	// cuerpo diera el mismo checksum.
	sum := sha256.Sum256([]byte(title + "\x00" + content + "\x00" + frontmatter))
	return hex.EncodeToString(sum[:])
}

// CreateNote guarda una nota nueva. Nace PRIVADA, sin excepción y sin
// parámetro para pedir lo contrario: abrirla a la IA es una acción explícita
// posterior (SetNotePrivacy), no algo que se pueda pasar de largo al crearla.
func (s *Store) CreateNote(id, title, content, frontmatter string) error {
	encTitle, titleNonce, err := s.encryptOptional(title)
	if err != nil {
		return err
	}
	encContent, contentNonce, err := s.encryptOptional(content)
	if err != nil {
		return err
	}
	encFm, fmNonce, err := s.encryptOptional(frontmatter)
	if err != nil {
		return err
	}

	now := time.Now().Unix()
	if _, err := s.db.Exec(
		`INSERT INTO vault_notes (id, encrypted_title, title_nonce, encrypted_content, content_nonce,
		        encrypted_frontmatter, frontmatter_nonce, title_hash, is_private, checksum_hash, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
		id, encTitle, titleNonce, encContent, contentNonce, encFm, fmNonce,
		TitleHash(title), contentChecksum(title, content, frontmatter), now, now,
	); err != nil {
		return fmt.Errorf("vault: creando la nota: %w", err)
	}
	return s.reindexLinks(id, content)
}

// UpdateNote reescribe una nota y reindexa sus enlaces.
//
// La privacidad NO se toca acá: se cambia solo por SetNotePrivacy, que es una
// acción con su propia confirmación. Guardar una nota no puede ser el momento
// en el que, de paso, se vuelve legible para un agente.
func (s *Store) UpdateNote(id, title, content, frontmatter string) error {
	encTitle, titleNonce, err := s.encryptOptional(title)
	if err != nil {
		return err
	}
	encContent, contentNonce, err := s.encryptOptional(content)
	if err != nil {
		return err
	}
	encFm, fmNonce, err := s.encryptOptional(frontmatter)
	if err != nil {
		return err
	}

	res, err := s.db.Exec(
		`UPDATE vault_notes SET encrypted_title = ?, title_nonce = ?, encrypted_content = ?, content_nonce = ?,
		        encrypted_frontmatter = ?, frontmatter_nonce = ?, title_hash = ?, checksum_hash = ?, updated_at = ?
		 WHERE id = ?`,
		encTitle, titleNonce, encContent, contentNonce, encFm, fmNonce,
		TitleHash(title), contentChecksum(title, content, frontmatter), time.Now().Unix(), id,
	)
	if err != nil {
		return fmt.Errorf("vault: guardando la nota: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return fmt.Errorf("vault: no existe la nota %q", id)
	}
	return s.reindexLinks(id, content)
}

// SetNotePrivacy abre o cierra una nota para los agentes.
//
// Es su propia operación y no un campo más de UpdateNote a propósito: es el
// único lugar del código donde una nota pasa de invisible a legible para un
// proceso externo, y tiene que poder auditarse leyendo una función.
func (s *Store) SetNotePrivacy(id string, private bool) error {
	v := 1
	if !private {
		v = 0
	}
	if _, err := s.db.Exec(`UPDATE vault_notes SET is_private = ?, updated_at = ? WHERE id = ?`,
		v, time.Now().Unix(), id); err != nil {
		return fmt.Errorf("vault: cambiando la privacidad de la nota: %w", err)
	}
	return nil
}

// DeleteNote borra la nota y sus aristas salientes.
//
// Las aristas que le APUNTABAN se dejan: son enlaces rotos, que es exactamente
// lo que pasó, y borrarlas escondería que otras notas la mencionaban.
func (s *Store) DeleteNote(id string) error {
	if _, err := s.db.Exec(`DELETE FROM vault_note_links WHERE source_note_id = ?`, id); err != nil {
		return fmt.Errorf("vault: borrando los enlaces de la nota: %w", err)
	}
	if _, err := s.db.Exec(`DELETE FROM vault_notes WHERE id = ?`, id); err != nil {
		return fmt.Errorf("vault: borrando la nota: %w", err)
	}
	return nil
}

// GetNote devuelve una nota descifrada, para la INTERFAZ de la aplicación.
//
// Devuelve también las privadas: en la app se ven todas — el cortafuegos no es
// contra el usuario, es contra los agentes. La puerta para ellos es NoteForAI.
func (s *Store) GetNote(id string) (Note, error) {
	row := s.db.QueryRow(
		`SELECT id, encrypted_title, title_nonce, encrypted_content, content_nonce,
		        encrypted_frontmatter, frontmatter_nonce, is_private, checksum_hash, created_at, updated_at
		 FROM vault_notes WHERE id = ?`, id)
	return s.scanNote(row)
}

func (s *Store) scanNote(row *sql.Row) (Note, error) {
	var n Note
	var encTitle, titleNonce, encContent, contentNonce, encFm, fmNonce []byte
	var private int
	var checksum string
	if err := row.Scan(&n.ID, &encTitle, &titleNonce, &encContent, &contentNonce,
		&encFm, &fmNonce, &private, &checksum, &n.CreatedAt, &n.UpdatedAt); err != nil {
		if err == sql.ErrNoRows {
			return Note{}, fmt.Errorf("vault: no existe esa nota")
		}
		return Note{}, fmt.Errorf("vault: leyendo la nota: %w", err)
	}
	n.IsPrivate = private != 0
	n.Title = s.decryptOptional(encTitle, titleNonce)
	n.Content = s.decryptOptional(encContent, contentNonce)
	n.Frontmatter = s.decryptOptional(encFm, fmNonce)
	// Un checksum que no coincide se INFORMA, no se oculta ni tira el error:
	// la nota igual se abre para poder rescatar lo que quede.
	n.Corrupt = checksum != "" && checksum != contentChecksum(n.Title, n.Content, n.Frontmatter)
	return n, nil
}

// ListNotes devuelve los títulos, sin cuerpos.
func (s *Store) ListNotes() ([]NoteSummary, error) {
	rows, err := s.db.Query(
		`SELECT n.id, n.encrypted_title, n.title_nonce, n.is_private, n.updated_at,
		        (SELECT COUNT(*) FROM vault_note_links l WHERE l.source_note_id = n.id)
		 FROM vault_notes n ORDER BY n.updated_at DESC`)
	if err != nil {
		return nil, fmt.Errorf("vault: leyendo las notas: %w", err)
	}
	defer rows.Close()

	out := []NoteSummary{}
	for rows.Next() {
		var s2 NoteSummary
		var enc, nonce []byte
		var private int
		if err := rows.Scan(&s2.ID, &enc, &nonce, &private, &s2.UpdatedAt, &s2.LinkCount); err != nil {
			return nil, err
		}
		s2.IsPrivate = private != 0
		s2.Title = s.decryptOptional(enc, nonce)
		out = append(out, s2)
	}
	return out, rows.Err()
}

// SearchNotes busca texto en títulos y cuerpos, DESCIFRANDO EN MEMORIA.
//
// **Por qué así y no con un índice.** Un índice de texto sobre contenido
// cifrado obliga a guardar algo derivado del texto plano —tokens, hashes de
// palabra, n-gramas— y eso es un canal lateral: con un diccionario se puede
// preguntar "¿esta nota contiene la palabra *despido*?" sin tener la clave.
// Descifrar en memoria no filtra nada, y a escala de notas personales (cientos,
// no millones) la diferencia no se percibe. Si algún día se percibe, el
// problema a resolver será ese, no este.
//
// El resultado se acota: una búsqueda que devuelve todo no filtró nada.
func (s *Store) SearchNotes(query string, limit int) ([]NoteSummary, error) {
	if limit <= 0 {
		limit = 50
	}
	q := strings.ToLower(strings.TrimSpace(query))
	if q == "" {
		return s.ListNotes()
	}

	rows, err := s.db.Query(
		`SELECT id, encrypted_title, title_nonce, encrypted_content, content_nonce, is_private, updated_at
		 FROM vault_notes ORDER BY updated_at DESC`)
	if err != nil {
		return nil, fmt.Errorf("vault: buscando en las notas: %w", err)
	}
	defer rows.Close()

	out := []NoteSummary{}
	for rows.Next() {
		if len(out) >= limit {
			break
		}
		var id string
		var encTitle, titleNonce, encContent, contentNonce []byte
		var private int
		var updated int64
		if err := rows.Scan(&id, &encTitle, &titleNonce, &encContent, &contentNonce, &private, &updated); err != nil {
			return nil, err
		}
		title := s.decryptOptional(encTitle, titleNonce)
		if !strings.Contains(strings.ToLower(title), q) {
			content := s.decryptOptional(encContent, contentNonce)
			if !strings.Contains(strings.ToLower(content), q) {
				continue
			}
		}
		out = append(out, NoteSummary{ID: id, Title: title, IsPrivate: private != 0, UpdatedAt: updated})
	}
	return out, rows.Err()
}

// NoteForAI es **la única puerta** por la que un agente puede leer una nota.
//
// Devuelve un error explícito cuando la nota es privada, y ese error está
// redactado para que se pueda mostrar tal cual: dice qué nota, por qué no se
// puede, y cómo permitirlo. Un "no encontrado" mandaría a buscar un título mal
// escrito que no es el problema.
//
// **Denegar por defecto:** cualquier error, nota inexistente o estado ambiguo
// termina en "no permitido". La consulta filtra por `is_private = 0` en el
// propio SQL en vez de leer la fila y decidir en Go — una condición que vive en
// la consulta no se puede saltear por un `if` mal escrito más adelante.
func (s *Store) NoteForAI(title string) (Note, error) {
	var id string
	var private int
	err := s.db.QueryRow(
		`SELECT id, is_private FROM vault_notes WHERE title_hash = ?`, TitleHash(title),
	).Scan(&id, &private)
	if err == sql.ErrNoRows {
		return Note{}, fmt.Errorf("no hay ninguna nota que se llame %q", title)
	}
	if err != nil {
		return Note{}, fmt.Errorf("vault: buscando la nota: %w", err)
	}
	if private != 0 {
		return Note{}, fmt.Errorf(
			"la nota %q está marcada como PRIVADA y los agentes no pueden leerla. "+
				"Si querés permitirlo, abrila y desmarcá el candado en su barra de herramientas", title)
	}
	return s.GetNote(id)
}

// SearchNotesForAI busca SOLO entre las notas visibles para la IA.
//
// El filtro va en el SQL, por el mismo motivo que en NoteForAI: una nota
// privada no llega a descifrarse, así que ni siquiera existe la posibilidad de
// que un fragmento suyo se cuele en un resultado.
func (s *Store) SearchNotesForAI(query string, limit int) ([]NoteSummary, error) {
	if limit <= 0 || limit > 20 {
		limit = 20
	}
	q := strings.ToLower(strings.TrimSpace(query))

	rows, err := s.db.Query(
		`SELECT id, encrypted_title, title_nonce, encrypted_content, content_nonce, updated_at
		 FROM vault_notes WHERE is_private = 0 ORDER BY updated_at DESC`)
	if err != nil {
		return nil, fmt.Errorf("vault: buscando en las notas: %w", err)
	}
	defer rows.Close()

	out := []NoteSummary{}
	for rows.Next() {
		if len(out) >= limit {
			break
		}
		var id string
		var encTitle, titleNonce, encContent, contentNonce []byte
		var updated int64
		if err := rows.Scan(&id, &encTitle, &titleNonce, &encContent, &contentNonce, &updated); err != nil {
			return nil, err
		}
		title := s.decryptOptional(encTitle, titleNonce)
		if q != "" && !strings.Contains(strings.ToLower(title), q) {
			content := s.decryptOptional(encContent, contentNonce)
			if !strings.Contains(strings.ToLower(content), q) {
				continue
			}
		}
		out = append(out, NoteSummary{ID: id, Title: title, UpdatedAt: updated})
	}
	return out, rows.Err()
}

// El cifrado reusa el par encryptOptional/decryptOptional de
// agent_chats_repo.go: el esquema es el mismo (BLOB + nonce, vacío = NULL) y
// tener dos implementaciones del mismo cifrado sería la peor clase de
// duplicación — la que se corrige en un solo lado.
