package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"

	"mini-tools/backend/vault"
)

// Bindings del módulo de notas: la base de conocimiento cifrada.
//
// Todo pasa por `requireUnlocked` sin excepción (.claude/rules/technical.md
// punto 5). No es una formalidad: acá vive documentación técnica del usuario
// —runbooks, procedimientos, notas de incidentes— y es contenido, no una
// preferencia de interfaz como el tema.
//
// **Ninguna de estas funciones es la puerta de la IA.** El agente y el
// servidor MCP entran únicamente por `vault.NoteForAI`, que filtra por
// `is_private = 0` en la propia consulta. Ver el resolvedor `@note` en
// app_refs.go.

// NoteTitle es una entrada del autocompletado de `[[`: lo mínimo para elegir.
type NoteTitle struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	IsPrivate bool   `json:"isPrivate"`
}

// ListNotes devuelve los títulos de todas las notas, de la más reciente a la
// más vieja. Incluye las privadas: en la aplicación se ven todas.
func (a *App) ListNotes() ([]vault.NoteSummary, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return a.vault.ListNotes()
}

// SearchNotesSmart es el buscador de la base de conocimiento: varios términos
// obligatorios en cualquier orden, insensible a tildes y mayúsculas, frases
// entre comillas, filtros (`tag:`, `enlaza:`, `privado:`), ordenado por
// relevancia y con el fragmento donde acertó.
//
// Ver backend/vault/notesearch.go para el ranking y para por qué no hay un
// índice persistido.
func (a *App) SearchNotesSmart(query string, limit int) ([]vault.NoteHit, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return a.vault.SearchNotesSmart(query, limit)
}

// GetNote abre una nota para la interfaz.
func (a *App) GetNote(id string) (vault.Note, error) {
	if err := a.requireUnlocked(); err != nil {
		return vault.Note{}, err
	}
	return a.vault.GetNote(id)
}

// CreateNote crea una nota. **Nace privada**, y el id lo genera el backend con
// `crypto/rand` (misma convención que el resto del vault: sin `google/uuid`).
func (a *App) CreateNote(title, content string) (string, error) {
	if err := a.requireUnlocked(); err != nil {
		return "", err
	}
	if strings.TrimSpace(title) == "" {
		return "", fmt.Errorf("app: la nota necesita un título — es lo que la hace enlazable con [[…]]")
	}

	// Un título duplicado se rechaza: dos notas con el mismo título hacen que
	// un `[[enlace]]` sea ambiguo, y el grafo tendría que elegir una en
	// silencio. Mejor pedir otro nombre que resolverlo por sorteo.
	existing, err := a.vault.ListNotes()
	if err != nil {
		return "", err
	}
	for _, n := range existing {
		if vault.NormalizeTitle(n.Title) == vault.NormalizeTitle(title) {
			return "", fmt.Errorf("app: ya existe una nota que se llama %q — los títulos tienen que ser únicos para que [[%s]] apunte a una sola", n.Title, title)
		}
	}

	id, err := newNoteID()
	if err != nil {
		return "", err
	}
	if err := a.vault.CreateNote(id, title, content, ""); err != nil {
		return "", err
	}
	return id, nil
}

// UpdateNote guarda una nota. No toca la privacidad: eso es SetNotePrivacy.
func (a *App) UpdateNote(id, title, content, frontmatter string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	if strings.TrimSpace(title) == "" {
		return fmt.Errorf("app: la nota necesita un título")
	}
	return a.vault.UpdateNote(id, title, content, frontmatter)
}

// SetNotePrivacy abre o cierra una nota para los agentes.
func (a *App) SetNotePrivacy(id string, private bool) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.SetNotePrivacy(id, private)
}

// DeleteNote borra una nota. Los enlaces que le apuntaban quedan rotos y
// visibles a propósito — ver Store.DeleteNote.
func (a *App) DeleteNote(id string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.DeleteNote(id)
}

// NoteLinks son los enlaces que SALEN de una nota, resueltos contra las que
// existen. Un destino inexistente vuelve con id vacío: es un enlace roto, que
// es información y no un error.
func (a *App) NoteLinks(id string) ([]vault.NoteLink, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return a.vault.NoteLinks(id)
}

// NoteBacklinks son las notas que APUNTAN a esta.
func (a *App) NoteBacklinks(id string) ([]vault.NoteLink, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return a.vault.NoteBacklinks(id)
}

// NoteTitles alimenta el autocompletado de `[[`.
//
// Los títulos se descifran en memoria para armar esta lista y no se persisten
// en claro en ningún lado — es el mismo criterio que la búsqueda.
func (a *App) NoteTitles() ([]NoteTitle, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	list, err := a.vault.ListNotes()
	if err != nil {
		return nil, err
	}
	out := make([]NoteTitle, 0, len(list))
	for _, n := range list {
		out = append(out, NoteTitle{ID: n.ID, Title: n.Title, IsPrivate: n.IsPrivate})
	}
	return out, nil
}

// SetNotesLayout persiste qué nota quedó abierta y el ancho de la lista.
//
// Sin `requireUnlocked`, igual que SetAgentLayout y por el mismo motivo: es
// disposición de la interfaz, sin contenido adentro. El ID de una nota es un
// identificador opaco generado al azar, no dice nada de ella.
func (a *App) SetNotesLayout(lastOpen string, sideWidth int) error {
	return a.vault.SetNotesLayout(lastOpen, sideWidth)
}

// newNoteID genera el id con crypto/rand + hex, la convención de ids de este
// proyecto (ver .claude/rules/conventions.md — nada de google/uuid).
func newNoteID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("app: generando el id de la nota: %w", err)
	}
	return hex.EncodeToString(b), nil
}
