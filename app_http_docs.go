package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"mini-tools/backend/httpclient"
	"mini-tools/backend/vault"
)

// Documentación de una colección publicada como nota del vault (fase 7).
//
// **Publicar, no exportar.** La nota no es una copia muerta: vive en la base de
// conocimiento, se busca desde el buscador de notas, se enlaza desde un runbook
// con `[[API · X]]` y el agente la puede leer. Por eso la documentación que el
// usuario escribe en cada petición es Markdown y se copia tal cual: un
// `[[enlace]]` escrito ahí se convierte en una arista real del grafo cuando la
// colección se publica.
//
// **La regla de las notas manda.** Regenerar NO pisa lo que editó una persona.
// Es el mismo contrato que tiene el agente por MCP (ver notes_provenance.go), y
// por el mismo motivo: una nota que alguien mejoró a mano y que la próxima
// regeneración borra es una nota que nadie va a mejorar a mano nunca más.

// HttpDocsResult es lo que pasó al publicar.
type HttpDocsResult struct {
	NoteID string `json:"noteId"`
	Title  string `json:"title"`
	// Status es "created", "updated" o "skipped".
	Status   string `json:"status"`
	Requests int    `json:"requests"`
	// Markdown es el documento generado. Va también cuando el estado es
	// "skipped": es lo que permite ofrecerle al usuario ver o copiar lo que se
	// habría escrito, en vez de dejarlo con una negativa a secas.
	Markdown string `json:"markdown"`
}

// HttpDocsPreview arma la documentación sin escribir nada.
func (a *App) HttpDocsPreview(collectionID string) (string, error) {
	if err := a.requireUnlocked(); err != nil {
		return "", err
	}
	md, _, err := a.buildCollectionDocs(collectionID)
	return md, err
}

// HttpPublishDocs publica —o regenera— la nota de una colección.
func (a *App) HttpPublishDocs(collectionID string) (*HttpDocsResult, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	md, col, err := a.buildCollectionDocs(collectionID)
	if err != nil {
		return nil, err
	}
	title := httpclient.DocTitle(col.Name)
	res := &HttpDocsResult{Title: title, Requests: len(col.Requests), Markdown: md}

	// Una nota vinculada que ya no existe (el usuario la borró) no es un
	// error: se vuelve a publicar desde cero.
	if noteID := a.linkedDocsNote(collectionID); noteID != "" {
		note, err := a.vault.GetNote(noteID)
		if err == nil {
			res.NoteID = note.ID
			if !vault.GeneratorCanEdit(note.Frontmatter, vault.HTTPDocsOriginMark) {
				res.Status = "skipped"
				res.Title = note.Title
				return res, nil
			}
			fm := vault.WithAgentUpdate(note.Frontmatter, time.Now())
			if err := a.vault.UpdateNote(note.ID, note.Title, md, fm); err != nil {
				return nil, err
			}
			res.Status, res.Title = "updated", note.Title
			runtime.EventsEmit(a.ctx, NoteChangedEvent, map[string]string{"id": note.ID, "title": note.Title})
			return res, nil
		}
	}

	fm := vault.NewGeneratedFrontmatter(vault.HTTPDocsOriginMark, "colección «"+col.Name+"»", time.Now())
	id, err := a.createNote(title, md, fm)
	if err != nil {
		return nil, err
	}
	if err := a.vault.SetHTTPCollectionNote(collectionID, id); err != nil {
		return nil, err
	}
	res.NoteID, res.Status = id, "created"
	runtime.EventsEmit(a.ctx, NoteChangedEvent, map[string]string{"id": id, "title": title})
	return res, nil
}

// linkedDocsNote es el id de la nota publicada de una colección, o "".
func (a *App) linkedDocsNote(collectionID string) string {
	cols, err := a.vault.ListHTTPCollections()
	if err != nil {
		return ""
	}
	for _, c := range cols {
		if c.ID == collectionID {
			return c.DocsNoteID
		}
	}
	return ""
}

// buildCollectionDocs junta la colección, su árbol y su autenticación heredada,
// y devuelve el Markdown ya enmascarado.
func (a *App) buildCollectionDocs(collectionID string) (string, httpclient.DocCollection, error) {
	var col vault.HTTPCollection
	cols, err := a.vault.ListHTTPCollections()
	if err != nil {
		return "", httpclient.DocCollection{}, err
	}
	found := false
	for _, c := range cols {
		if c.ID == collectionID {
			col, found = c, true
			break
		}
	}
	if !found {
		return "", httpclient.DocCollection{}, fmt.Errorf("app: no existe la colección %q", collectionID)
	}

	items, err := a.vault.ListHTTPItems(collectionID)
	if err != nil {
		return "", httpclient.DocCollection{}, err
	}

	doc := httpclient.DocCollection{
		Name:        col.Name,
		Description: col.Description,
		Variables:   decodeVariables(col.Variables),
		Auth:        decodeAuth(col.Auth),
	}
	// Nombres de las carpetas, para poder decir de cuál hereda una petición su
	// autenticación sin volver a leer el ítem.
	names := map[string]string{}
	for _, it := range items {
		names[it.ID] = it.Name
	}
	for _, node := range walkHTTPTree(items, "", "") {
		doc.Requests = append(doc.Requests, a.docRequest(node.item, node.folder, names))
	}

	md := httpclient.BuildDocs(doc)

	// Enmascarado al final, sobre el documento entero: si un valor secreto
	// quedó escrito a mano dentro de una URL o de un cuerpo —en vez de como
	// {{variable}}— acá se tapa igual. Una nota puede ser leída por el agente,
	// así que el filtro tiene que ser el último paso y no una precaución
	// repartida por cada campo.
	return httpclient.MaskSecrets(md, a.varScopes(collectionID)), doc, nil
}

// treeNode es una petición con la ruta de carpetas que la contiene.
type treeNode struct {
	item   vault.HTTPItem
	folder string
}

// walkHTTPTree recorre el árbol en el mismo orden en que se ve en la barra
// lateral. Importa: el índice de la nota agrupa por carpeta asumiendo que las
// peticiones de una misma carpeta vienen seguidas, que es lo que garantiza un
// recorrido en profundidad y no el listado plano ordenado por sort_order.
func walkHTTPTree(items []vault.HTTPItem, parentID, prefix string) []treeNode {
	var out []treeNode
	for _, it := range items {
		if it.ParentID != parentID {
			continue
		}
		if it.Kind == "folder" {
			path := it.Name
			if prefix != "" {
				path = prefix + " / " + it.Name
			}
			out = append(out, walkHTTPTree(items, it.ID, path)...)
			continue
		}
		out = append(out, treeNode{item: it, folder: prefix})
	}
	return out
}

func (a *App) docRequest(it vault.HTTPItem, folder string, names map[string]string) httpclient.DocRequest {
	r := httpclient.DocRequest{
		Name:     it.Name,
		Method:   it.Method,
		URL:      it.URL,
		Folder:   folder,
		Docs:     it.Docs,
		Params:   decodeKeyValues(it.Params),
		PathVars: decodeKeyValues(it.PathVars),
		Headers:  decodeKeyValues(it.Headers),
	}
	if strings.TrimSpace(it.Body) != "" {
		_ = json.Unmarshal([]byte(it.Body), &r.Body)
	}
	r.Auth, r.AuthFrom = a.docAuth(it, names)
	return r
}

// docAuth resuelve la autenticación efectiva SIN resolver variables, al revés
// que el envío: acá el objetivo es documentar la forma de la petición, y
// resolver `{{token}}` metería el valor del entorno activo dentro de la nota.
func (a *App) docAuth(it vault.HTTPItem, names map[string]string) (httpclient.Auth, string) {
	levels, err := a.vault.HTTPAuthChain(it.ID)
	if err != nil {
		return httpclient.Auth{}, ""
	}
	for _, level := range levels {
		auth := decodeAuth(level.Auth)
		if auth.Type == "" || auth.Type == httpclient.AuthInherit {
			continue
		}
		switch {
		case level.ItemID == "":
			// La de la colección ya está documentada arriba: repetirla en cada
			// petición sería veinte líneas diciendo lo mismo.
			return httpclient.Auth{}, ""
		case level.ItemID == it.ID:
			return auth, "propia"
		default:
			return auth, "heredada de «" + names[level.ItemID] + "»"
		}
	}
	return httpclient.Auth{}, ""
}

// HttpSaveResponseExample agrega la respuesta recibida a la documentación de la
// petición, como ejemplo.
//
// **Se agrega al final en vez de reemplazar.** Una petición útil tiene más de
// un ejemplo —el caso que funciona y el 422 que explica qué valida el
// servidor—, y pisar el anterior obligaría a elegir cuál conservar cada vez.
//
// Pasa por el mismo filtro que todo lo que sale del vault: valores de variables
// secretas enmascarados y credenciales tapadas. Un ejemplo guardado termina en
// una nota que el agente puede leer y en un export que se manda por chat.
func (a *App) HttpSaveResponseExample(itemID string, req httpclient.Request, resp httpclient.Response) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	if itemID == "" {
		return fmt.Errorf("app: guardá la petición en una colección antes de guardarle un ejemplo")
	}
	if resp.Status == 0 {
		return fmt.Errorf("app: no hay respuesta que guardar")
	}
	it, err := a.vault.GetHTTPItem(itemID)
	if err != nil {
		return err
	}

	var b strings.Builder
	if strings.TrimSpace(it.Docs) != "" {
		b.WriteString(strings.TrimRight(it.Docs, "\n"))
		b.WriteString("\n\n")
	}
	fmt.Fprintf(&b, "### Ejemplo · %d %s\n\n", resp.Status, resp.StatusText)
	fmt.Fprintf(&b, "```http\n%s %s\n```\n\n", strings.ToUpper(req.Method), req.URL)

	switch {
	case resp.IsBinary:
		fmt.Fprintf(&b, "Respuesta binaria (%s, %d bytes).\n", resp.ContentType, resp.SizeBytes)
	case strings.TrimSpace(resp.Body) != "":
		lang := resp.Lang
		if lang == "" {
			lang = "text"
		}
		fmt.Fprintf(&b, "```%s\n%s\n```\n", lang, clip(strings.TrimRight(resp.Body, "\n"), maxBodyExample))
	default:
		b.WriteString("Sin cuerpo.\n")
	}

	docs := httpclient.RedactCredentials(httpclient.MaskSecrets(b.String(), a.varScopes(it.CollectionID)))
	it.Docs = docs
	_, err = a.vault.SaveHTTPItem(*it)
	return err
}

// maxBodyExample acota el ejemplo. Una respuesta de dos megabytes no documenta
// mejor que sus primeras líneas: documenta peor, porque nadie la lee.
const maxBodyExample = 4000

// clip recorta por runas: cortar a la mitad un carácter acentuado deja basura.
func clip(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return strings.TrimSpace(string(r[:max])) + "\n… (recortado)"
}
