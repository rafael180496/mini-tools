package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strings"

	"mini-tools/backend/vault"

	"github.com/wailsapp/wails/v2/pkg/runtime"
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

// CreateNote crea una nota. Nace **visible para los agentes** (ver la migración
// 34); esconderla es `SetNotePrivacy`. El id lo genera el backend con
// `crypto/rand`, la convención de ids de este proyecto.
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

// NotePrivacyEvent es el nombre del evento que avisa que una nota cambió de
// privacidad.
//
// **Por qué un evento y no que cada vista se entere por su cuenta.** El estado
// "esta nota la puede leer un agente" se muestra en cuatro lugares a la vez —
// la insignia del editor, el candado del árbol, el nodo del grafo y el panel de
// acceso— y se puede cambiar desde varios. Sin un aviso, el que no hizo el
// cambio se queda mostrando lo de antes, y ahí el candado deja de ser
// información y pasa a ser una suposición. En un control de privacidad eso no
// es un detalle de refresco: es la diferencia entre creer que algo está
// escondido y que lo esté.
const NotePrivacyEvent = "note:privacy"

// SetNotePrivacy esconde o vuelve a mostrar una nota a los agentes.
func (a *App) SetNotePrivacy(id string, private bool) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	if err := a.vault.SetNotePrivacy(id, private); err != nil {
		return err
	}
	// Después de que la escritura salió bien, nunca antes: avisar de un cambio
	// que falló haría que todas las vistas se pongan de acuerdo en algo falso.
	runtime.EventsEmit(a.ctx, NotePrivacyEvent, map[string]any{"id": id, "isPrivate": private})
	return nil
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

// SetNotesLastOpen recuerda qué nota quedó abierta, para reabrirla al arrancar.
//
// Solo el id, y **no el ancho del panel**: la versión anterior de esta función
// escribía los dos, así que abrir una nota pisaba el ancho con un valor fijo
// —el que pasara quien llamara— y borraba el que el usuario hubiera dejado. Dos
// cosas que cambian por motivos distintos no se guardan con la misma llamada.
//
// Sin `requireUnlocked`, igual que SetAgentLayout y por el mismo motivo: es
// disposición de la interfaz. El id de una nota es un identificador opaco
// generado al azar, no dice nada de ella.
func (a *App) SetNotesLastOpen(noteID string) error {
	return a.vault.SetNotesLastOpen(noteID)
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

// NotesGraph devuelve el grafo de conocimiento: nodos y aristas, **sin el
// contenido de ninguna nota**. Ver Store.NoteGraph.
func (a *App) NotesGraph() (vault.NoteGraphData, error) {
	if err := a.requireUnlocked(); err != nil {
		return vault.NoteGraphData{}, err
	}
	return a.vault.NoteGraph()
}

// SetNoteFolder mueve una nota a una carpeta ("" = raíz).
//
// Las carpetas de notas reusan la tabla `folders` con `scope = "note"`, el
// mismo mecanismo que ya organiza conexiones, SSH y repositorios: cada módulo
// tiene su propio árbol y nunca se mezclan.
func (a *App) SetNoteFolder(noteID, folderID string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.SetNoteFolder(noteID, folderID)
}

// NoteStats son los números que van en la barra de estado de una nota:
// cuántas la enlazan y cuánto tiene escrito.
type NoteStats struct {
	Backlinks int `json:"backlinks"`
	Words     int `json:"words"`
	Chars     int `json:"chars"`
}

// NoteStatsFor calcula los números de una nota.
//
// Las palabras se cuentan en el backend y no en el frontend porque el
// contenido ya está descifrado acá: mandarlo entero solo para contarlo sería
// pasear el texto por el binding sin motivo.
func (a *App) NoteStatsFor(id string) (NoteStats, error) {
	if err := a.requireUnlocked(); err != nil {
		return NoteStats{}, err
	}
	note, err := a.vault.GetNote(id)
	if err != nil {
		return NoteStats{}, err
	}
	back, err := a.vault.NoteBacklinks(id)
	if err != nil {
		return NoteStats{}, err
	}
	return NoteStats{
		Backlinks: len(back),
		Words:     len(strings.Fields(note.Content)),
		Chars:     len([]rune(note.Content)),
	}, nil
}

// SaveNoteImage guarda una imagen pegada en una nota y devuelve la referencia
// que hay que escribir en el Markdown (`nota:ID`).
//
// `dataBase64` llega como `data:image/png;base64,…` (lo que da el portapapeles
// del navegador). Se valida que sea una imagen: el vault de notas no es un
// almacén de archivos arbitrarios, y aceptar cualquier cosa sería convertirlo
// en uno sin decirlo.
func (a *App) SaveNoteImage(noteID, dataURL string) (string, error) {
	if err := a.requireUnlocked(); err != nil {
		return "", err
	}

	const prefix = "data:"
	if !strings.HasPrefix(dataURL, prefix) {
		return "", fmt.Errorf("app: eso no es una imagen")
	}
	comma := strings.Index(dataURL, ",")
	if comma < 0 {
		return "", fmt.Errorf("app: la imagen llegó incompleta")
	}
	header := dataURL[len(prefix):comma]
	mime, _, _ := strings.Cut(header, ";")
	if !strings.HasPrefix(mime, "image/") {
		return "", fmt.Errorf("app: solo se pueden pegar imágenes en una nota, y esto es %q", mime)
	}

	raw, err := base64.StdEncoding.DecodeString(dataURL[comma+1:])
	if err != nil {
		return "", fmt.Errorf("app: no se pudo leer la imagen: %w", err)
	}

	id, err := newNoteID()
	if err != nil {
		return "", err
	}
	if err := a.vault.SaveNoteAsset(id, noteID, mime, raw); err != nil {
		return "", err
	}
	return id, nil
}

// GetNoteImage devuelve una imagen descifrada como base64, para mostrarla.
func (a *App) GetNoteImage(id string) (vault.NoteAsset, error) {
	if err := a.requireUnlocked(); err != nil {
		return vault.NoteAsset{}, err
	}
	return a.vault.GetNoteAsset(id)
}

// NoteTags devuelve las etiquetas que ya existen en tus notas, con cuántas la
// usan. Alimenta el autocompletado de `#`: mismo principio que el
// autocompletado de SQL — se ofrecen las que ya existen, no inventadas.
func (a *App) NoteTags() ([]vault.NoteTag, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return a.vault.AllNoteTags()
}
