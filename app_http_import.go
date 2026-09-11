package main

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"mini-tools/backend/httpclient"
	"mini-tools/backend/vault"
)

// Importación del módulo HTTP: una sola puerta para todo lo que se puede
// traer de afuera.
//
// Antes había dos caminos sin relación entre sí —un botón que abría el
// selector de archivos y esperaba una colección de Postman, y un diálogo
// aparte para pegar un cURL—, así que importar exigía saber de antemano qué
// clase de cosa se tenía y por dónde entraba. Acá el contenido se clasifica
// solo (`httpclient.DetectImport`) y el diálogo dice qué reconoció antes de
// escribir nada.
//
// Lo que entra: colección de Postman (v2.0/v2.1), entorno de Postman, volcado
// de datos de Postman, comando cURL, petición HTTP en texto plano y una URL
// suelta. Lo que NO: OpenAPI/Swagger, HAR e Insomnia — son parsers propios y
// quedan fuera de este alcance.

// httpImportMaxFiles es el tope de archivos de una carpeta arrastrada. Una
// carpeta de proyecto entera trae miles de `.json` que no son colecciones, y
// abrirlos todos para descubrirlo es trabajo inútil que además se ve como un
// cuelgue.
const httpImportMaxFiles = 200

// httpImportMaxFileBytes es el tope por archivo. Una colección grande de
// verdad ronda unos pocos MB; más que esto es otra cosa que se llama igual.
const httpImportMaxFileBytes = 64 << 20

// HttpImportOutcome es UNA cosa importada. Un archivo puede dar varias (un
// volcado trae colecciones y entornos), y por eso el resultado es una lista y
// no un objeto: "se importó" sin decir qué obliga a ir a buscarlo al árbol.
type HttpImportOutcome struct {
	// Kind: "collection" | "environment" | "request".
	Kind string `json:"kind"`
	// Source es el archivo del que salió, o "" si vino pegado.
	Source        string `json:"source,omitempty"`
	CollectionID  string `json:"collectionId,omitempty"`
	ItemID        string `json:"itemId,omitempty"`
	EnvironmentID string `json:"environmentId,omitempty"`
	Name          string `json:"name"`
	Method        string `json:"method,omitempty"`
	URL           string `json:"url,omitempty"`
	Requests      int    `json:"requests"`
	Folders       int    `json:"folders"`
	Variables     int    `json:"variables"`
	// Warnings son cosas que entraron pero no se van a ejecutar tal cual.
	Warnings []string `json:"warnings,omitempty"`
	// Error es por qué ESTE archivo no entró. Un archivo ilegible en una
	// carpeta de veinte no puede tumbar la importación de los otros
	// diecinueve, pero tampoco puede desaparecer sin decirlo.
	Error string `json:"error,omitempty"`
}

// HttpImportBatch es el resumen de una importación completa.
type HttpImportBatch struct {
	Items        []HttpImportOutcome `json:"items"`
	Collections  int                 `json:"collections"`
	Environments int                 `json:"environments"`
	Requests     int                 `json:"requests"`
	Folders      int                 `json:"folders"`
	Failed       int                 `json:"failed"`
	// Skipped son archivos que ni se abrieron (no eran JSON, o se pasó el
	// tope de la carpeta).
	Skipped int `json:"skipped"`
}

func (b *HttpImportBatch) add(o HttpImportOutcome) {
	if o.Error != "" {
		b.Failed++
		b.Items = append(b.Items, o)
		return
	}
	switch o.Kind {
	case "collection":
		b.Collections++
	case "environment":
		b.Environments++
	}
	b.Requests += o.Requests
	b.Folders += o.Folders
	b.Items = append(b.Items, o)
}

// HttpImportDetect dice qué es un contenido pegado, sin importar nada.
//
// Es lo que permite que el diálogo muestre «colección de Postman · 23
// peticiones» mientras se escribe, en vez de pedir que se confíe y se mire
// después el árbol.
func (a *App) HttpImportDetect(text string) (*httpclient.ImportDetection, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	d := httpclient.DetectImport([]byte(text))
	return &d, nil
}

// HttpImportText importa lo que se pegó en el diálogo.
//
// `collectionID` solo se usa cuando lo pegado es UNA petición (cURL, texto
// plano o una URL): es la colección donde se guarda. Vacío significa "creá
// una", porque una petición importada que no queda en ningún lado es una
// petición que se pierde al cerrar la pestaña.
func (a *App) HttpImportText(text, collectionID string) (*HttpImportBatch, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	batch := &HttpImportBatch{Items: []HttpImportOutcome{}}
	if err := a.importBlob([]byte(text), "", collectionID, batch); err != nil {
		return nil, err
	}
	return batch, nil
}

// HttpImportFiles importa archivos y carpetas: lo que se soltó en la zona de
// arrastre o lo que se eligió en el selector.
//
// Una carpeta se recorre entera buscando `.json`; lo que no sea una colección
// o un entorno se saltea en silencio, porque una carpeta de un proyecto tiene
// `package.json` y `tsconfig.json` y reportarlos como errores convertiría el
// resumen en ruido.
func (a *App) HttpImportFiles(paths []string) (*HttpImportBatch, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}

	batch := &HttpImportBatch{Items: []HttpImportOutcome{}}
	files, skipped := expandImportPaths(paths)
	batch.Skipped = skipped

	for _, path := range files {
		info, err := os.Stat(path)
		if err != nil {
			batch.add(HttpImportOutcome{Source: path, Name: filepath.Base(path), Error: err.Error()})
			continue
		}
		if info.Size() > httpImportMaxFileBytes {
			batch.add(HttpImportOutcome{Source: path, Name: filepath.Base(path),
				Error: fmt.Sprintf("el archivo pesa %d MB; el tope es %d MB", info.Size()>>20, httpImportMaxFileBytes>>20)})
			continue
		}
		data, err := os.ReadFile(path)
		if err != nil {
			batch.add(HttpImportOutcome{Source: path, Name: filepath.Base(path), Error: err.Error()})
			continue
		}
		if err := a.importBlob(data, path, "", batch); err != nil {
			return nil, err
		}
	}
	return batch, nil
}

// HttpImportPickFiles abre el selector con selección múltiple. Devuelve una
// lista vacía si el usuario cancela, que no es un error.
func (a *App) HttpImportPickFiles() ([]string, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	paths, err := runtime.OpenMultipleFilesDialog(a.ctx, runtime.OpenDialogOptions{
		Title:   "Elegir colecciones, entornos o volcados de Postman",
		Filters: []runtime.FileFilter{{DisplayName: "JSON de Postman (*.json)", Pattern: "*.json"}},
	})
	if err != nil {
		return nil, fmt.Errorf("app: abriendo el selector: %w", err)
	}
	if paths == nil {
		paths = []string{}
	}
	return paths, nil
}

// HttpImportPickFolder abre el selector de carpetas. "" si se canceló.
func (a *App) HttpImportPickFolder() (string, error) {
	if err := a.requireUnlocked(); err != nil {
		return "", err
	}
	dir, err := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Elegir una carpeta con colecciones de Postman",
	})
	if err != nil {
		return "", fmt.Errorf("app: abriendo el selector: %w", err)
	}
	return dir, nil
}

// --- interno -----------------------------------------------------------------

// importBlob clasifica un contenido y lo escribe. El error de retorno es solo
// para fallos de la bóveda: lo que sea culpa del CONTENIDO viaja como un
// outcome con `Error`, para que un archivo malo no cancele los demás.
func (a *App) importBlob(data []byte, source, collectionID string, batch *HttpImportBatch) error {
	name := ""
	if source != "" {
		name = filepath.Base(source)
	}
	det := httpclient.DetectImport(data)

	switch det.Kind {
	case httpclient.ImportPostmanCollection:
		out, err := a.importPostmanCollection(data, source)
		if err != nil {
			if isVaultFailure(err) {
				return err
			}
			batch.add(HttpImportOutcome{Source: source, Name: name, Error: err.Error()})
			return nil
		}
		batch.add(*out)

	case httpclient.ImportPostmanEnvironment:
		out, err := a.importPostmanEnvironment(data, source)
		if err != nil {
			if isVaultFailure(err) {
				return err
			}
			batch.add(HttpImportOutcome{Source: source, Name: name, Error: err.Error()})
			return nil
		}
		batch.add(*out)

	case httpclient.ImportPostmanDump:
		if err := a.importPostmanDump(data, source, batch); err != nil {
			return err
		}

	case httpclient.ImportCurl, httpclient.ImportRawHTTP, httpclient.ImportURL:
		req, reqName, err := parseSingleRequest(det.Kind, string(data))
		if err != nil {
			batch.add(HttpImportOutcome{Source: source, Name: name, Error: err.Error()})
			return nil
		}
		out, err := a.saveImportedRequest(req, reqName, collectionID, source)
		if err != nil {
			return err
		}
		batch.add(*out)

	default:
		if name == "" {
			name = "lo pegado"
		}
		batch.add(HttpImportOutcome{Source: source, Name: name, Error: det.Reason})
	}
	return nil
}

func (a *App) importPostmanCollection(data []byte, source string) (*HttpImportOutcome, error) {
	parsed, err := httpclient.ParsePostman(data)
	if err != nil {
		return nil, err
	}

	col, err := a.vault.SaveHTTPCollection(vault.HTTPCollection{
		Name:        parsed.Name,
		Description: parsed.Description,
		Variables:   marshalOrEmpty(parsed.Variables),
		Auth:        marshalAuth(parsed.Auth),
		PreRequest:  parsed.PreRequest,
		TestScript:  parsed.TestScript,
	})
	if err != nil {
		return nil, vaultFailure{err}
	}
	if parsed.Raw != "" {
		_ = a.vault.SaveHTTPCollectionRaw(col.ID, parsed.Raw)
	}

	counter := &HttpImportResult{CollectionID: col.ID, Name: col.Name}
	if err := a.importItems(col.ID, "", parsed.Items, counter); err != nil {
		// La colección a medias se borra: media colección importada es peor
		// que ninguna, porque parece completa.
		_ = a.vault.DeleteHTTPCollection(col.ID)
		return nil, vaultFailure{err}
	}

	return &HttpImportOutcome{
		Kind: "collection", Source: source, CollectionID: col.ID, Name: col.Name,
		Requests: counter.Requests, Folders: counter.Folders,
		Variables: len(parsed.Variables), Warnings: parsed.Warnings,
	}, nil
}

func (a *App) importPostmanEnvironment(data []byte, source string) (*HttpImportOutcome, error) {
	parsed, err := httpclient.ParsePostmanEnvironment(data)
	if err != nil {
		return nil, err
	}
	env, err := a.vault.SaveHTTPEnvironment(vault.HTTPEnvironment{
		Name:      parsed.Name,
		Variables: marshalOrEmpty(parsed.Variables),
	})
	if err != nil {
		return nil, vaultFailure{err}
	}
	return &HttpImportOutcome{
		Kind: "environment", Source: source, EnvironmentID: env.ID,
		Name: env.Name, Variables: len(parsed.Variables),
	}, nil
}

// importPostmanDump recorre un volcado de datos (Settings → Data → Export),
// que trae colecciones y entornos en un solo archivo.
func (a *App) importPostmanDump(data []byte, source string, batch *HttpImportBatch) error {
	cols, envs, err := httpclient.SplitPostmanDump(data)
	if err != nil {
		batch.add(HttpImportOutcome{Source: source, Name: filepath.Base(source), Error: err.Error()})
		return nil
	}
	for _, raw := range cols {
		if err := a.importBlob(raw, source, "", batch); err != nil {
			return err
		}
	}
	for _, raw := range envs {
		if err := a.importBlob(raw, source, "", batch); err != nil {
			return err
		}
	}
	return nil
}

// saveImportedRequest guarda una petición suelta. Sin colección elegida se
// crea una: una petición importada que no queda en ningún lado se pierde al
// cerrar la pestaña, que es justo lo contrario de importarla.
func (a *App) saveImportedRequest(req httpclient.Request, name, collectionID, source string) (*HttpImportOutcome, error) {
	if collectionID == "" {
		col, err := a.vault.SaveHTTPCollection(vault.HTTPCollection{Name: "Importadas"})
		if err != nil {
			return nil, err
		}
		collectionID = col.ID
	}
	saved, err := a.vault.SaveHTTPItem(vault.HTTPItem{
		CollectionID: collectionID,
		Kind:         "request",
		Name:         name,
		Method:       req.Method,
		URL:          req.URL,
		Params:       marshalOrEmpty(req.Params),
		Headers:      marshalOrEmpty(req.Headers),
		Body:         marshalBody(req.Body),
		Auth:         marshalAuth(req.Auth),
	})
	if err != nil {
		return nil, err
	}
	return &HttpImportOutcome{
		Kind: "request", Source: source, CollectionID: collectionID, ItemID: saved.ID,
		Name: saved.Name, Method: saved.Method, URL: saved.URL, Requests: 1,
	}, nil
}

func parseSingleRequest(kind httpclient.ImportKind, text string) (httpclient.Request, string, error) {
	text = strings.TrimSpace(text)
	switch kind {
	case httpclient.ImportCurl:
		req, err := httpclient.ParseCurl(text)
		return req, requestName(req), err
	case httpclient.ImportRawHTTP:
		req, err := httpclient.ParseRawHTTP(text)
		return req, requestName(req), err
	case httpclient.ImportURL:
		req := httpclient.Request{
			Method: "GET", URL: text,
			Settings: httpclient.DefaultSettings(),
			Body:     httpclient.Body{Mode: httpclient.BodyNone},
			Auth:     httpclient.Auth{Type: httpclient.AuthInherit},
		}
		return req, requestName(req), nil
	}
	return httpclient.Request{}, "", fmt.Errorf("no es una petición")
}

// requestName nombra la petición con el último tramo de la ruta, que es lo
// que la distingue de sus hermanas en el árbol. La URL entera como nombre
// deja una lista de entradas idénticas recortadas por el mismo lugar.
func requestName(req httpclient.Request) string {
	raw := req.URL
	if i := strings.Index(raw, "?"); i >= 0 {
		raw = raw[:i]
	}
	raw = strings.TrimRight(raw, "/")
	if i := strings.LastIndex(raw, "/"); i >= 0 && i+1 < len(raw) {
		last := raw[i+1:]
		if last != "" && !strings.Contains(last, "://") {
			return last
		}
	}
	if raw == "" {
		return "Petición importada"
	}
	return raw
}

// expandImportPaths convierte lo que se soltó (archivos, carpetas o una
// mezcla) en la lista de archivos a abrir.
func expandImportPaths(paths []string) (files []string, skipped int) {
	seen := map[string]bool{}
	add := func(p string) {
		if len(files) >= httpImportMaxFiles {
			skipped++
			return
		}
		if seen[p] {
			return
		}
		seen[p] = true
		files = append(files, p)
	}

	for _, p := range paths {
		info, err := os.Stat(p)
		if err != nil {
			skipped++
			continue
		}
		if !info.IsDir() {
			// Un archivo elegido a mano se abre aunque no termine en .json:
			// quien lo eligió ya dijo que es eso. El filtro por extensión es
			// para lo que se descubre solo dentro de una carpeta.
			add(p)
			continue
		}
		_ = filepath.WalkDir(p, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			base := filepath.Base(path)
			if d.IsDir() {
				// Las carpetas ocultas y node_modules no tienen colecciones y
				// sí decenas de miles de archivos.
				if path != p && (strings.HasPrefix(base, ".") || base == "node_modules") {
					return fs.SkipDir
				}
				return nil
			}
			if !strings.EqualFold(filepath.Ext(base), ".json") {
				return nil
			}
			add(path)
			return nil
		})
	}
	return files, skipped
}

// vaultFailure distingue "este archivo no servía" de "la bóveda falló". Lo
// primero se reporta por archivo y se sigue; lo segundo corta la importación,
// porque seguir escribiendo contra una bóveda que falla solo multiplica el
// desastre.
type vaultFailure struct{ err error }

func (v vaultFailure) Error() string { return v.err.Error() }
func (v vaultFailure) Unwrap() error { return v.err }

func isVaultFailure(err error) bool {
	_, ok := err.(vaultFailure)
	return ok
}
