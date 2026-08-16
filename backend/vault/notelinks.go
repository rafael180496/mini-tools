package vault

import (
	"fmt"
	"strings"
	"time"
)

// WikiLinks: el grafo de la base de conocimiento.
//
// La sintaxis es la de Obsidian, `[[Título]]`, con alias opcional
// `[[Título|texto que se muestra]]`. Se eligió esa y no una propia porque es la
// que ya está en la cabeza de quien usa este tipo de herramienta, y porque una
// nota exportada a `.md` tiene que abrirse en Obsidian sin pérdida.
//
// El destino se guarda como HASH del título normalizado, nunca como id de nota:
// un enlace puede apuntar a algo que todavía no existe —así es como se crean
// las notas en un grafo— y eso no se puede representar con una clave foránea.

// ExtractWikiLinks saca los títulos enlazados de un Markdown, sin repetidos y
// en orden de aparición.
//
// Tolerante a fallos como el resto de los parsers de este proyecto: un `[[` sin
// cerrar es texto, un `[[]]` vacío se ignora, y los corchetes dentro de un
// bloque de código se saltean — un ejemplo de código que contenga `[[algo]]` no
// es un enlace, y tratarlo como tal ensuciaría el grafo con nodos inventados.
func ExtractWikiLinks(markdown string) []string {
	var out []string
	seen := map[string]bool{}

	inFence := false
	for _, line := range strings.Split(markdown, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~") {
			inFence = !inFence
			continue
		}
		if inFence {
			continue
		}
		for _, title := range wikiLinksInLine(line) {
			key := NormalizeTitle(title)
			if key == "" || seen[key] {
				continue
			}
			seen[key] = true
			out = append(out, title)
		}
	}
	return out
}

func wikiLinksInLine(line string) []string {
	var out []string
	// El código en línea también queda afuera, por el mismo motivo que los
	// bloques: `` `[[esto]]` `` es un ejemplo, no un enlace.
	segments := splitOutsideInlineCode(line)
	for _, seg := range segments {
		for i := 0; i+1 < len(seg); i++ {
			if seg[i] != '[' || seg[i+1] != '[' {
				continue
			}
			end := strings.Index(seg[i+2:], "]]")
			if end < 0 {
				break
			}
			inner := seg[i+2 : i+2+end]
			// El alias es presentación: `[[Runbook|el runbook viejo]]` apunta a
			// "Runbook". Se corta por la primera barra.
			if bar := strings.IndexByte(inner, '|'); bar >= 0 {
				inner = inner[:bar]
			}
			if t := strings.TrimSpace(inner); t != "" {
				out = append(out, t)
			}
			i = i + 2 + end + 1
		}
	}
	return out
}

func splitOutsideInlineCode(line string) []string {
	parts := strings.Split(line, "`")
	out := make([]string, 0, len(parts)/2+1)
	// Los índices pares están fuera del código en línea; los impares, adentro.
	for i := 0; i < len(parts); i += 2 {
		out = append(out, parts[i])
	}
	return out
}

// reindexLinks reescribe las aristas salientes de una nota.
//
// Borrar e insertar dentro de UNA transacción: si se hiciera en dos
// operaciones sueltas y la app se cerrara en el medio, la nota quedaría sin
// ningún enlace y el grafo mostraría un nodo aislado que en realidad no lo es.
func (s *Store) reindexLinks(noteID, content string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("vault: reindexando enlaces: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.Exec(`DELETE FROM vault_note_links WHERE source_note_id = ?`, noteID); err != nil {
		return fmt.Errorf("vault: limpiando enlaces anteriores: %w", err)
	}
	now := time.Now().Unix()
	for _, title := range ExtractWikiLinks(content) {
		if _, err := tx.Exec(
			`INSERT INTO vault_note_links (source_note_id, target_title_hash, created_at) VALUES (?, ?, ?)`,
			noteID, TitleHash(title), now,
		); err != nil {
			return fmt.Errorf("vault: guardando un enlace: %w", err)
		}
	}
	return tx.Commit()
}

// NoteLinks devuelve los enlaces SALIENTES de una nota, ya resueltos.
//
// Un enlace cuyo destino no existe vuelve con TargetID vacío: es un enlace
// roto, se dibuja distinto y ofrece crear la nota. Ocultarlo escondería
// justamente el trabajo pendiente que el grafo sirve para ver.
func (s *Store) NoteLinks(noteID string) ([]NoteLink, error) {
	rows, err := s.db.Query(
		`SELECT l.target_title_hash, COALESCE(n.id, ''), COALESCE(n.encrypted_title, x''), COALESCE(n.title_nonce, x''),
		        COALESCE(n.is_private, 0)
		 FROM vault_note_links l
		 LEFT JOIN vault_notes n ON n.title_hash = l.target_title_hash
		 WHERE l.source_note_id = ?`, noteID)
	if err != nil {
		return nil, fmt.Errorf("vault: leyendo los enlaces: %w", err)
	}
	return s.scanLinks(rows)
}

// NoteBacklinks devuelve las notas que APUNTAN a esta.
//
// Es la mitad más útil del grafo: los enlaces salientes ya se ven escribiendo,
// los entrantes son los que uno no recuerda haber puesto.
func (s *Store) NoteBacklinks(noteID string) ([]NoteLink, error) {
	rows, err := s.db.Query(
		`SELECT l.target_title_hash, src.id, src.encrypted_title, src.title_nonce, src.is_private
		 FROM vault_note_links l
		 JOIN vault_notes src ON src.id = l.source_note_id
		 WHERE l.target_title_hash = (SELECT title_hash FROM vault_notes WHERE id = ?)
		   AND src.id <> ?`, noteID, noteID)
	if err != nil {
		return nil, fmt.Errorf("vault: leyendo los backlinks: %w", err)
	}
	return s.scanLinks(rows)
}

func (s *Store) scanLinks(rows interface {
	Next() bool
	Scan(...any) error
	Close() error
	Err() error
}) ([]NoteLink, error) {
	defer rows.Close()
	out := []NoteLink{}
	for rows.Next() {
		var l NoteLink
		var enc, nonce []byte
		var private int
		if err := rows.Scan(&l.TargetHash, &l.TargetID, &enc, &nonce, &private); err != nil {
			return nil, err
		}
		l.IsPrivate = private != 0
		l.Title = s.decryptOptional(enc, nonce)
		out = append(out, l)
	}
	return out, rows.Err()
}

// BrokenLinkTitles son los títulos enlazados desde una nota que todavía no
// existen. Se derivan del contenido y no de la tabla porque ahí solo hay
// hashes, y un hash no se puede mostrar como "creá esta nota".
func BrokenLinkTitles(content string, existing map[string]bool) []string {
	var out []string
	for _, t := range ExtractWikiLinks(content) {
		if !existing[TitleHash(t)] {
			out = append(out, t)
		}
	}
	return out
}
