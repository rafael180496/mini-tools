package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"os"
	"regexp"
	"strings"
	"time"

	"mini-tools/backend/i18n"
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
	return a.createNote(title, content, "")
}

// createNote es el alta de verdad: la usa el binding de la interfaz y también
// el servidor MCP, que además guarda un frontmatter diciendo que la escribió un
// agente. Un segundo camino de alta terminaría, tarde o temprano, sin la
// comprobación de títulos duplicados que hay acá abajo.
func (a *App) createNote(title, content, frontmatter string) (string, error) {
	if err := a.requireUnlocked(); err != nil {
		return "", err
	}
	if strings.TrimSpace(title) == "" {
		return "", i18n.Errorf(i18n.Msg{ES: "app: la nota necesita un título — es lo que la hace enlazable con [[…]]", EN: "app: the note needs a title — it's what makes it linkable with [[…]]"})
	}

	// Un título duplicado se rechaza: dos notas con el mismo título hacen que
	// un `[[enlace]]` sea ambiguo, y el grafo tendría que elegir una en
	// silencio. Mejor pedir otro nombre que resolverlo por sorteo.
	if err := a.checkNoteTitleFree(title, ""); err != nil {
		return "", err
	}

	id, err := newNoteID()
	if err != nil {
		return "", err
	}
	if err := a.vault.CreateNote(id, title, content, frontmatter); err != nil {
		return "", err
	}
	return id, nil
}

// CreateNoteInFolder crea una nota ya dentro de una carpeta.
//
// Existe como un solo verbo en vez de "crear y después mover" desde el
// frontend: entre las dos llamadas la nota existe en la raíz, y la barra
// lateral que se refresca en el medio la dibuja ahí y después la ve saltar. Con
// carpeta vacía es exactamente CreateNote, así que el botón «+» de la raíz y el
// de una carpeta son el mismo camino.
func (a *App) CreateNoteInFolder(title, folderID string) (string, error) {
	id, err := a.createNote(title, "", "")
	if err != nil {
		return "", err
	}
	if folderID != "" {
		if err := a.vault.SetNoteFolder(id, folderID); err != nil {
			return "", err
		}
	}
	return id, nil
}

// UpdateNote guarda una nota. No toca la privacidad: eso es SetNotePrivacy.
//
// **Guardar desde la aplicación marca la nota como tocada por el usuario.** Solo
// importa en las notas que creó un agente por MCP: desde el momento en que una
// persona la edita, deja de ser editable por el agente (ver mcpCanEditNote). Es
// la garantía que hace aceptable darle permiso de escritura — lo que escribió
// una persona no lo pisa un modelo, ni siquiera en una nota que él empezó.
func (a *App) UpdateNote(id, title, content, frontmatter string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	if strings.TrimSpace(title) == "" {
		return i18n.Errorf(i18n.Msg{ES: "app: la nota necesita un título", EN: "app: the note needs a title"})
	}
	return a.vault.UpdateNote(id, title, content, vault.WithUserTouch(frontmatter, time.Now()))
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

// NoteChangedEvent avisa que una nota apareció o cambió SIN que la interfaz lo
// haya hecho.
//
// Existe por el servidor MCP: cuando un agente crea o reescribe una nota, el
// árbol, el grafo y —sobre todo— la pestaña que la tenga abierta tienen que
// enterarse. Una nota que aparece recién al reabrir la app se lee como que no
// se guardó; y un editor que sigue mostrando el texto viejo puede pisar con su
// autoguardado lo que el agente acaba de escribir.
//
// Payload: {id, title}. El id es lo que permite al editor saber si le habla a
// él sin comparar títulos, que además pueden repetirse en el camino.
const NoteChangedEvent = "note:changed"

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
	if err := a.vault.DeleteNote(id); err != nil {
		return err
	}
	runtime.EventsEmit(a.ctx, NoteRemovedEvent, map[string]string{"id": id})
	return nil
}

// NoteRemovedEvent avisa que una nota dejó de existir (borrada o fundida en
// otra). Lo escucha el marco de pestañas: sin él, la pestaña de la nota queda
// abierta y su autoguardado falla contra una fila que ya no está. Con
// `mergedInto`, la pestaña salta a la nota que la absorbió.
const NoteRemovedEvent = "note:removed"

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
		return "", i18n.Errorf(i18n.Msg{ES: "app: generando el id de la nota: %w", EN: "app: generating the note id: %w"}, err)
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
		return "", i18n.Errorf(i18n.Msg{ES: "app: eso no es una imagen", EN: "app: that is not an image"})
	}
	comma := strings.Index(dataURL, ",")
	if comma < 0 {
		return "", i18n.Errorf(i18n.Msg{ES: "app: la imagen llegó incompleta", EN: "app: the image arrived incomplete"})
	}
	header := dataURL[len(prefix):comma]
	mime, _, _ := strings.Cut(header, ";")
	if !strings.HasPrefix(mime, "image/") {
		return "", i18n.Errorf(i18n.Msg{ES: "app: solo se pueden pegar imágenes en una nota, y esto es %q", EN: "app: only images can be pasted into a note, and this is %q"}, mime)
	}

	raw, err := base64.StdEncoding.DecodeString(dataURL[comma+1:])
	if err != nil {
		return "", i18n.Errorf(i18n.Msg{ES: "app: no se pudo leer la imagen: %w", EN: "app: couldn't read the image: %w"}, err)
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

// checkNoteTitleFree rechaza un título que ya usa otra nota (except es la
// propia, al renombrar). Un solo lugar para la regla: alta, renombre y
// duplicado tienen que decir lo mismo.
func (a *App) checkNoteTitleFree(title, except string) error {
	existing, err := a.vault.ListNotes()
	if err != nil {
		return err
	}
	for _, n := range existing {
		if n.ID != except && vault.NormalizeTitle(n.Title) == vault.NormalizeTitle(title) {
			return i18n.Errorf(i18n.Msg{ES: "app: ya existe una nota que se llama %q — los títulos tienen que ser únicos para que [[%s]] apunte a una sola", EN: "app: a note named %q already exists — titles must be unique so that [[%s]] points to a single one"}, n.Title, title)
		}
	}
	return nil
}

// RenameNote cambia solo el título, desde el menú contextual de la barra.
//
// Emite NoteChangedEvent porque la nota puede estar abierta: sin el aviso el
// editor seguiría con el título viejo y su autoguardado desharía el renombre.
// Los enlaces [[Título viejo]] de otras notas NO se reescriben — quedan rotos,
// y la interfaz lo dice antes de confirmar.
func (a *App) RenameNote(id, title string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	title = strings.TrimSpace(title)
	if title == "" {
		return i18n.Errorf(i18n.Msg{ES: "app: la nota necesita un título", EN: "app: the note needs a title"})
	}
	if err := a.checkNoteTitleFree(title, id); err != nil {
		return err
	}
	n, err := a.vault.GetNote(id)
	if err != nil {
		return err
	}
	if err := a.vault.UpdateNote(id, title, n.Content, n.Frontmatter); err != nil {
		return err
	}
	runtime.EventsEmit(a.ctx, NoteChangedEvent, map[string]string{"id": id, "title": title})
	return nil
}

// DuplicateNote copia una nota —cuerpo, etiquetas, carpeta, privacidad e
// imágenes— con el título «X (copia)», o «X (copia 2)» si ese ya existe.
func (a *App) DuplicateNote(id string) (string, error) {
	if err := a.requireUnlocked(); err != nil {
		return "", err
	}
	src, err := a.vault.GetNote(id)
	if err != nil {
		return "", err
	}
	base := i18n.T(i18n.Msg{ES: "%s (copia)", EN: "%s (copy)"}, strings.TrimSpace(src.Title))
	title := base
	for i := 2; a.checkNoteTitleFree(title, "") != nil; i++ {
		if i > 100 {
			return "", i18n.Errorf(i18n.Msg{ES: "app: no se encontró un título libre para la copia de %q", EN: "app: couldn't find a free title for the copy of %q"}, src.Title)
		}
		title = i18n.T(i18n.Msg{ES: "%s (copia %d)", EN: "%s (copy %d)"}, strings.TrimSpace(src.Title), i)
	}
	newID, err := newNoteID()
	if err != nil {
		return "", err
	}
	if err := a.vault.DuplicateNote(id, newID, title, newNoteID); err != nil {
		return "", err
	}
	return newID, nil
}

// SetNotePinned fija una nota arriba de la barra lateral, o la suelta.
func (a *App) SetNotePinned(id string, pinned bool) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.SetNotePinned(id, pinned)
}

// MergeNotes funde src al final de dst (con el título de src como encabezado)
// y borra src. Si cualquiera de las dos era privada, el resultado es privado:
// ver vault.MergeNotes.
func (a *App) MergeNotes(srcID, dstID string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	dst, err := a.vault.GetNote(dstID)
	if err != nil {
		return err
	}
	src, err := a.vault.GetNote(srcID)
	if err != nil {
		return err
	}
	if err := a.vault.MergeNotes(srcID, dstID); err != nil {
		return err
	}
	runtime.EventsEmit(a.ctx, NoteRemovedEvent, map[string]string{"id": srcID, "mergedInto": dstID})
	runtime.EventsEmit(a.ctx, NoteChangedEvent, map[string]string{"id": dstID, "title": dst.Title})
	if src.IsPrivate && !dst.IsPrivate {
		runtime.EventsEmit(a.ctx, NotePrivacyEvent, map[string]any{"id": dstID, "isPrivate": true})
	}
	return nil
}

var noteImageRef = regexp.MustCompile(`\(nota:([0-9a-f]+)\)`)

// ExportNoteMarkdown guarda la nota como un .md donde el usuario elija.
//
// Las imágenes van **incrustadas** como `data:` URI: el esquema `nota:ID` solo
// existe adentro de esta app, y un .md exportado con esas referencias se abre
// en Obsidian sin ninguna imagen. Incrustadas, el archivo es uno solo y se ve
// completo en cualquier editor.
//
// Es la única salida en claro de una nota a disco, y por eso va siempre por el
// diálogo de guardado: nunca a un temporal que después abra otra aplicación.
// Devuelve la ruta, o "" si se canceló.
func (a *App) ExportNoteMarkdown(id string) (string, error) {
	if err := a.requireUnlocked(); err != nil {
		return "", err
	}
	n, err := a.vault.GetNote(id)
	if err != nil {
		return "", err
	}

	body := noteImageRef.ReplaceAllStringFunc(n.Content, func(m string) string {
		asset, err := a.vault.GetNoteAsset(noteImageRef.FindStringSubmatch(m)[1])
		if err != nil {
			return m
		}
		return "(data:" + asset.Mime + ";base64," + asset.Data + ")"
	})
	if strings.TrimSpace(n.Frontmatter) != "" {
		body = "---\n" + strings.TrimSpace(n.Frontmatter) + "\n---\n\n" + body
	}

	dest, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           i18n.T(i18n.Msg{ES: "Exportar nota como Markdown", EN: "Export note as Markdown"}),
		DefaultFilename: safeFilename(n.Title) + ".md",
		Filters:         []runtime.FileFilter{{DisplayName: "Markdown (*.md)", Pattern: "*.md"}},
	})
	if err != nil {
		return "", i18n.Errorf(i18n.Msg{ES: "app: abriendo diálogo de guardado: %w", EN: "app: opening save dialog: %w"}, err)
	}
	if dest == "" {
		return "", nil
	}
	if err := os.WriteFile(dest, []byte(body), 0o600); err != nil {
		return "", i18n.Errorf(i18n.Msg{ES: "app: escribiendo la nota: %w", EN: "app: writing the note: %w"}, err)
	}
	return dest, nil
}
