package main

import (
	"fmt"
	"strings"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"mini-tools/backend/i18n"
	"mini-tools/backend/mcpserver"
	"mini-tools/backend/vault"
)

// Herramientas de notas del servidor MCP (las ve un CLI por el puente y un
// servidor de modelos por CallTool). Las reglas que no se negocian son las de
// siempre y viven en el vault:
//
//   - **Nada privado.** Todo lo que se lee pasa por vault.NoteForAI o por
//     vault.SearchSharedNotes / SharedFolderTree, que filtran `is_private = 0`
//     en la propia consulta. Las listas de enlaces, las carpetas y los conteos
//     tampoco nombran una nota privada.
//   - **Nada de reescribir lo del usuario.** Reescribir y ampliar exigen que la
//     nota la haya creado un agente y que nadie la haya editado después
//     (vault.AgentCanEdit).
//   - **Escritura solo con mcpNotesWrite**, comprobado en CADA llamada.

const (
	// maxMCPSearchHits acota la búsqueda: son títulos y un fragmento, y diez
	// alcanzan para elegir cuál leer.
	maxMCPSearchHits = 10
	// maxMCPListNotes acota una lista de carpeta; si hay más se dice.
	maxMCPListNotes = 100
	// maxMCPListFolders acota el árbol de carpetas.
	maxMCPListFolders = 200
	// maxMCPLinkList acota cada lista de enlaces de vault_read_note.
	maxMCPLinkList = 50
)

var msgNotesWriteOff = i18n.Msg{
	ES: "el usuario no habilitó que un agente escriba notas. Se activa en la aplicación, en Acceso de IA",
	EN: "the user hasn't allowed agents to write notes. It's enabled in the app, under AI access",
}

// emitNoteChanged avisa a la ventana que un agente creó o cambió una nota.
func (a *App) emitNoteChanged(payload map[string]string) {
	if a.noteEmit != nil {
		a.noteEmit(NoteChangedEvent, payload)
		return
	}
	runtime.EventsEmit(a.ctx, NoteChangedEvent, payload)
}

func folderLabel(path string) string {
	if path == "" {
		return i18n.T(i18n.Msg{ES: "(raíz)", EN: "(root)"})
	}
	return path
}

func hashTags(tags []string) string {
	if len(tags) == 0 {
		return ""
	}
	parts := make([]string, len(tags))
	for i, t := range tags {
		parts[i] = "#" + t
	}
	return strings.Join(parts, " ")
}

func noteDate(unix int64) string {
	return time.Unix(unix, 0).Format("2006-01-02")
}

// resolveFolderFilter traduce el argumento `folder` a los ids de esa carpeta y
// sus descendientes. ids nil = sin filtro. missing dice que la ruta no existe.
func (a *App) resolveFolderFilter(folder string) (ids map[string]bool, missing bool, err error) {
	if strings.TrimSpace(folder) == "" {
		return nil, false, nil
	}
	ids, found, err := a.vault.NoteFolderSubtree(folder)
	if err != nil {
		return nil, false, err
	}
	return ids, !found, nil
}

func missingFolderMsg(folder string) string {
	return i18n.T(i18n.Msg{
		ES: "No existe la carpeta %q (o no tiene notas compartidas). Mirá las que hay con vault_list_folders.",
		EN: "The folder %q doesn't exist (or has no shared notes). See the existing ones with vault_list_folders.",
	}, folder)
}

func (a *App) mcpSearchNotes(args map[string]any) (string, string, error) {
	q := mcpserver.StringArg(args, "query")
	folder := strings.TrimSpace(mcpserver.StringArg(args, "folder"))
	tag := strings.TrimSpace(mcpserver.StringArg(args, "tag"))
	resource := q
	if folder != "" {
		resource += " @" + folder
	}
	if tag != "" {
		resource += " #" + strings.TrimPrefix(tag, "#")
	}

	ids, missing, err := a.resolveFolderFilter(folder)
	if err != nil {
		return "", resource, err
	}
	if missing {
		return missingFolderMsg(folder), resource, nil
	}
	hits, err := a.vault.SearchSharedNotes(vault.SharedNoteFilter{Query: q, Tag: tag, FolderIDs: ids, Limit: maxMCPSearchHits})
	if err != nil {
		return "", resource, err
	}
	if len(hits) == 0 {
		return i18n.T(i18n.Msg{ES: "No hay ninguna nota compartida que coincida. Puede que exista pero esté marcada como privada por el usuario.", EN: "No shared note matches. It may exist but be marked as private by the user."}), resource, nil
	}
	paths, err := a.vault.NoteFolderPaths()
	if err != nil {
		return "", resource, err
	}
	var b strings.Builder
	for _, h := range hits {
		fmt.Fprintf(&b, "- %s — %s", h.Title, folderLabel(paths[h.FolderID]))
		if t := hashTags(h.Tags); t != "" {
			fmt.Fprintf(&b, " — %s", t)
		}
		b.WriteString("\n")
		if h.Snippet != "" {
			fmt.Fprintf(&b, "    %s\n", h.Snippet)
		}
	}
	return b.String(), resource, nil
}

func (a *App) mcpReadNote(args map[string]any) (string, string, error) {
	title := mcpserver.StringArg(args, "title")
	// El cortafuegos vive en NoteForAI, que filtra en la propia consulta
	// SQL. Acá no hay ninguna decisión de permisos que tomar — y eso es a
	// propósito.
	note, err := a.vault.NoteForAI(title)
	if err != nil {
		return "", title, err
	}

	paths, err := a.vault.NoteFolderPaths()
	if err != nil {
		return "", title, err
	}
	folderID, err := a.vault.NoteFolderID(note.ID)
	if err != nil {
		return "", title, err
	}

	var b strings.Builder
	fmt.Fprintf(&b, "%s: %s\n", i18n.T(i18n.Msg{ES: "Título", EN: "Title"}), note.Title)
	fmt.Fprintf(&b, "%s: %s\n", i18n.T(i18n.Msg{ES: "Carpeta", EN: "Folder"}), folderLabel(paths[folderID]))
	tags := hashTags(vault.NoteTags(note.Content, note.Frontmatter))
	if tags == "" {
		tags = i18n.T(i18n.Msg{ES: "(ninguna)", EN: "(none)"})
	}
	fmt.Fprintf(&b, "%s: %s\n", i18n.T(i18n.Msg{ES: "Etiquetas", EN: "Tags"}), tags)
	fmt.Fprintf(&b, "%s: %s\n", i18n.T(i18n.Msg{ES: "Actualizada", EN: "Updated"}), noteDate(note.UpdatedAt))

	out, in, err := a.visibleLinks(note)
	if err != nil {
		return "", title, err
	}
	fmt.Fprintf(&b, "%s: %s\n", i18n.T(i18n.Msg{ES: "Enlaza a", EN: "Links to"}), joinLinks(out))
	fmt.Fprintf(&b, "%s: %s\n", i18n.T(i18n.Msg{ES: "Enlazada desde", EN: "Linked from"}), joinLinks(in))

	// Quién la escribió solo se informa si el agente puede escribir: es lo que
	// le dice si vault_append_to_note va a funcionar, y evita que lo intente
	// a ciegas sobre una nota del usuario.
	if a.mcpNotesWrite() {
		who := i18n.T(i18n.Msg{ES: "usuario (no la podés modificar)", EN: "user (you can't modify it)"})
		if vault.AgentCanEdit(note.Frontmatter) {
			who = i18n.T(i18n.Msg{ES: "un agente, sin cambios del usuario (la podés ampliar con vault_append_to_note)", EN: "an agent, with no user edits (you can extend it with vault_append_to_note)"})
		} else if strings.Contains(note.Frontmatter, vault.AgentOriginMark) {
			who = i18n.T(i18n.Msg{ES: "un agente, pero el usuario la editó después (no la podés modificar)", EN: "an agent, but the user edited it afterwards (you can't modify it)"})
		}
		fmt.Fprintf(&b, "%s: %s\n", i18n.T(i18n.Msg{ES: "Escrita por", EN: "Written by"}), who)
	}
	b.WriteString("\n---\n\n")
	b.WriteString(note.Content)
	return b.String(), title, nil
}

// visibleLinks devuelve los títulos que la nota enlaza y los que la enlazan,
// SIN las notas privadas. Un enlace a una nota que no existe todavía se marca,
// porque es trabajo pendiente y a veces la pista de qué escribir.
func (a *App) visibleLinks(note vault.Note) (outgoing, incoming []linkRef, err error) {
	links, err := a.vault.NoteLinks(note.ID)
	if err != nil {
		return nil, nil, err
	}
	byHash := make(map[string]vault.NoteLink, len(links))
	for _, l := range links {
		byHash[l.TargetHash] = l
	}
	for _, t := range vault.ExtractWikiLinks(note.Content) {
		l, ok := byHash[vault.TitleHash(t)]
		switch {
		case ok && l.IsPrivate:
			// Una nota privada no se nombra, ni siquiera como destino.
		case ok && l.TargetID == "", !ok:
			outgoing = append(outgoing, linkRef{title: t, broken: true})
		default:
			outgoing = append(outgoing, linkRef{title: l.Title})
		}
	}
	back, err := a.vault.NoteBacklinks(note.ID)
	if err != nil {
		return nil, nil, err
	}
	for _, l := range back {
		if !l.IsPrivate {
			incoming = append(incoming, linkRef{title: l.Title})
		}
	}
	return dedupe(outgoing), dedupe(incoming), nil
}

// linkRef es un enlace listado; broken marca el que apunta a una nota que
// todavía no existe.
type linkRef struct {
	title  string
	broken bool
}

func dedupe(in []linkRef) []linkRef {
	seen := map[linkRef]bool{}
	var out []linkRef
	for _, l := range in {
		if !seen[l] {
			seen[l] = true
			out = append(out, l)
		}
	}
	return out
}

func joinLinks(links []linkRef) string {
	if len(links) == 0 {
		return i18n.T(i18n.Msg{ES: "(ninguno)", EN: "(none)"})
	}
	extra := 0
	if len(links) > maxMCPLinkList {
		extra = len(links) - maxMCPLinkList
		links = links[:maxMCPLinkList]
	}
	parts := make([]string, len(links))
	for i, l := range links {
		parts[i] = "[[" + l.title + "]]"
		if l.broken {
			parts[i] += " " + i18n.T(i18n.Msg{ES: "(no existe todavía)", EN: "(doesn't exist yet)"})
		}
	}
	s := strings.Join(parts, ", ")
	if extra > 0 {
		s += i18n.T(i18n.Msg{ES: " … y %d más", EN: " … and %d more"}, extra)
	}
	return s
}

func (a *App) mcpListFolders() (string, string, error) {
	folders, rootNotes, err := a.vault.SharedFolderTree()
	if err != nil {
		return "", "", err
	}
	if len(folders) == 0 && rootNotes == 0 {
		return i18n.T(i18n.Msg{ES: "No hay notas compartidas todavía.", EN: "There are no shared notes yet."}), "", nil
	}
	var b strings.Builder
	b.WriteString(i18n.T(i18n.Msg{
		ES: "Carpetas con notas compartidas (los conteos no incluyen notas privadas):\n",
		EN: "Folders with shared notes (counts leave out private notes):\n",
	}))
	for i, f := range folders {
		if i >= maxMCPListFolders {
			fmt.Fprintf(&b, "%s\n", i18n.T(i18n.Msg{ES: "… y %d carpetas más", EN: "… and %d more folders"}, len(folders)-maxMCPListFolders))
			break
		}
		fmt.Fprintf(&b, "- %s — %s\n", f.Path, i18n.T(i18n.Msg{ES: "%d notas (%d con subcarpetas)", EN: "%d notes (%d including subfolders)"}, f.Notes, f.Total))
	}
	fmt.Fprintf(&b, "- %s — %s\n", folderLabel(""), i18n.T(i18n.Msg{ES: "%d notas", EN: "%d notes"}, rootNotes))
	return b.String(), "", nil
}

func (a *App) mcpListNotes(args map[string]any) (string, string, error) {
	folder := strings.TrimSpace(mcpserver.StringArg(args, "folder"))
	recursive := mcpserver.BoolArg(args, "recursive")

	var ids map[string]bool
	switch {
	case folder != "":
		var missing bool
		var err error
		ids, missing, err = a.resolveFolderFilter(folder)
		if err != nil {
			return "", folder, err
		}
		if missing {
			return missingFolderMsg(folder), folder, nil
		}
		if !recursive {
			// Solo la propia carpeta: NoteFolderSubtree incluye descendientes.
			id, _, err := a.vault.FindNoteFolder(folder)
			if err != nil {
				return "", folder, err
			}
			ids = map[string]bool{id: true}
		}
	case !recursive:
		// Sin carpeta y sin recursión: las notas sueltas en la raíz.
		ids = map[string]bool{"": true}
	}

	notes, err := a.vault.SearchSharedNotes(vault.SharedNoteFilter{FolderIDs: ids, SortByTitle: true})
	if err != nil {
		return "", folder, err
	}
	if len(notes) == 0 {
		return i18n.T(i18n.Msg{ES: "No hay notas compartidas ahí.", EN: "There are no shared notes there."}), folder, nil
	}
	paths, err := a.vault.NoteFolderPaths()
	if err != nil {
		return "", folder, err
	}
	var b strings.Builder
	for i, n := range notes {
		if i >= maxMCPListNotes {
			fmt.Fprintf(&b, "%s\n", i18n.T(i18n.Msg{ES: "… y %d notas más (acotá con folder)", EN: "… and %d more notes (narrow with folder)"}, len(notes)-maxMCPListNotes))
			break
		}
		fmt.Fprintf(&b, "- %s", n.Title)
		if recursive {
			fmt.Fprintf(&b, " — %s", folderLabel(paths[n.FolderID]))
		}
		if t := hashTags(n.Tags); t != "" {
			fmt.Fprintf(&b, " — %s", t)
		}
		fmt.Fprintf(&b, " — %s\n", noteDate(n.UpdatedAt))
	}
	return b.String(), folder, nil
}

func (a *App) mcpCreateNote(args map[string]any) (string, string, error) {
	// El permiso se vuelve a comprobar acá y no solo al armar el catálogo:
	// entre que el agente leyó la lista y llama pueden pasar minutos, y en
	// el medio el usuario pudo revocarlo. Un permiso que solo se mira al
	// listar es un permiso que no se puede revocar.
	if !a.mcpNotesWrite() {
		return "", "", i18n.Errorf(i18n.Msg{ES: "el usuario no habilitó que un agente cree notas. Se activa en la aplicación, en Acceso de IA", EN: "the user hasn't allowed agents to create notes. It's enabled in the app, under AI access"})
	}
	title := strings.TrimSpace(mcpserver.StringArg(args, "title"))
	content := mcpserver.StringArg(args, "content")
	folder := strings.TrimSpace(mcpserver.StringArg(args, "folder"))
	if title == "" || strings.TrimSpace(content) == "" {
		return "", title, i18n.Errorf(i18n.Msg{ES: "hacen falta un título y un contenido", EN: "a title and content are required"})
	}
	// Tope de tamaño: una nota es algo que una persona va a leer. Sin
	// límite, una respuesta larga del modelo termina volcada entera en el
	// vault del usuario.
	if len(content) > maxMCPNoteBytes {
		return "", title, i18n.Errorf(i18n.Msg{ES: "la nota es demasiado grande (%d KB, máximo %d KB) — resumila o partila en varias", EN: "the note is too large (%d KB, max %d KB) — summarize it or split it into several"}, len(content)/1024, maxMCPNoteBytes/1024)
	}

	// Todo lo que puede rechazarse se comprueba ANTES de crear carpetas: una
	// nota rechazada por título repetido no debe dejar carpetas vacías.
	var canonicalFolder string
	if folder != "" {
		segs, err := vault.ParseFolderPath(folder)
		if err != nil {
			return "", title, err
		}
		canonicalFolder = strings.Join(segs, "/")
	}
	if err := a.checkNoteTitleFree(title, ""); err != nil {
		return "", title, err
	}
	folderID := ""
	if canonicalFolder != "" {
		id, err := a.vault.EnsureNoteFolder(canonicalFolder)
		if err != nil {
			return "", title, err
		}
		folderID = id
	}

	// El frontmatter es lo que hace que "¿esto lo escribí yo o el agente?"
	// tenga respuesta seis meses después. Va como metadato y no dentro del
	// texto: la nota se lee limpia, y el dato sigue ahí.
	fm := vault.NewAgentFrontmatter(time.Now())
	id, err := a.createNote(title, content, fm)
	if err != nil {
		return "", title, err
	}
	if folderID != "" {
		if err := a.vault.SetNoteFolder(id, folderID); err != nil {
			return "", title, err
		}
	}
	// La nota nace NO privada a propósito: la escribió el agente, no es un
	// secreto del usuario, y marcarla privada haría que ni siquiera pueda
	// releer lo que acaba de dejar asentado. Esconderla después es un clic
	// en la aplicación.
	a.emitNoteChanged(map[string]string{"id": id, "title": title})
	if canonicalFolder != "" {
		return i18n.T(i18n.Msg{ES: "Nota creada: %q en la carpeta %s. El usuario ya la ve en su base de conocimiento.", EN: "Note created: %q in folder %s. The user can already see it in their knowledge base."}, title, canonicalFolder), title, nil
	}
	return i18n.T(i18n.Msg{ES: "Nota creada: %q. El usuario ya la ve en su base de conocimiento.", EN: "Note created: %q. The user can already see it in their knowledge base."}, title), title, nil
}

// agentOwnedNote devuelve la nota si un agente puede modificarla: pasa por la
// misma puerta que la lectura (NoteForAI) y exige que la haya creado un agente
// y nadie la haya editado después.
func (a *App) agentOwnedNote(title string) (vault.Note, error) {
	// **La misma puerta que para leer.** NoteForAI ya rechaza las notas
	// privadas con un mensaje que explica por qué, así que la regla "una
	// nota privada no se toca" no se vuelve a escribir acá: si el agente no
	// la puede leer, tampoco la puede editar, y las dos cosas dependen de
	// una sola comprobación.
	note, err := a.vault.NoteForAI(title)
	if err != nil {
		return vault.Note{}, err
	}
	if !vault.AgentCanEdit(note.Frontmatter) {
		return vault.Note{}, i18n.Errorf(i18n.Msg{
			ES: "la nota %q no la creaste vos: la escribió el usuario, o vos la creaste y él la editó después. " +
				"Un agente solo puede reescribir sus propias notas intactas. " +
				"Si hace falta cambiarla, decíselo al usuario o creá una nota nueva que la complemente",
			EN: "you didn't create the note %q: the user wrote it, or you created it and they edited it afterwards. " +
				"An agent can only rewrite its own untouched notes. " +
				"If it needs changing, tell the user or create a new note that complements it",
		}, title)
	}
	return note, nil
}

func (a *App) mcpAppendToNote(args map[string]any) (string, string, error) {
	if !a.mcpNotesWrite() {
		return "", "", i18n.Errorf(msgNotesWriteOff)
	}
	title := strings.TrimSpace(mcpserver.StringArg(args, "title"))
	content := strings.TrimSpace(mcpserver.StringArg(args, "content"))
	heading := cleanHeading(mcpserver.StringArg(args, "heading"))
	if title == "" || content == "" {
		return "", title, i18n.Errorf(i18n.Msg{ES: "hacen falta el título de la nota y el contenido a agregar", EN: "the note title and the content to add are required"})
	}
	if len(content) > maxMCPNoteBytes {
		return "", title, i18n.Errorf(i18n.Msg{ES: "lo que agregás es demasiado grande (%d KB, máximo %d KB)", EN: "what you're adding is too large (%d KB, max %d KB)"}, len(content)/1024, maxMCPNoteBytes/1024)
	}

	note, err := a.agentOwnedNote(title)
	if err != nil {
		return "", title, err
	}

	section := content
	if heading != "" {
		section = "## " + heading + "\n\n" + content
	}
	merged := strings.TrimRight(note.Content, " \t\r\n")
	if merged != "" {
		merged += "\n\n"
	}
	merged += section + "\n"
	// El tope vale para el resultado y no solo para lo agregado: sin eso, un
	// bucle de appends termina en una nota que nadie lee.
	if len(merged) > maxMCPNoteBytes {
		return "", title, i18n.Errorf(i18n.Msg{ES: "la nota quedaría demasiado grande (%d KB, máximo %d KB): creá una nota nueva y enlazala", EN: "the note would get too large (%d KB, max %d KB): create a new note and link it"}, len(merged)/1024, maxMCPNoteBytes/1024)
	}

	// UpdateNote reindexa los enlaces con el cuerpo nuevo: un [[enlace]]
	// agregado acá aparece en el grafo y en los backlinks de inmediato.
	fm := vault.WithAgentUpdate(note.Frontmatter, time.Now())
	if err := a.vault.UpdateNote(note.ID, note.Title, merged, fm); err != nil {
		return "", title, err
	}
	a.emitNoteChanged(map[string]string{"id": note.ID, "title": note.Title})
	return i18n.T(i18n.Msg{ES: "Se agregó la sección a la nota %q.", EN: "Section added to note %q."}, note.Title), title, nil
}

// cleanHeading deja el encabezado en una línea y sin las almohadillas que el
// modelo suele poner: la herramienta ya agrega "## ".
func cleanHeading(h string) string {
	h = strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(h, "\r", " "), "\n", " "))
	return strings.TrimSpace(strings.TrimLeft(h, "# "))
}
