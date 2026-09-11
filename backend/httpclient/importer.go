package httpclient

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
)

// Detección de qué es lo que alguien acaba de pegar o soltar en el diálogo de
// importar.
//
// # Por qué detectar en vez de preguntar
//
// El material de importación siempre llega de otro lado —el «Copy as cURL»
// del navegador, un archivo que mandó un compañero, la URL de un endpoint que
// alguien dictó por teléfono— y quien lo pega no tiene por qué saber cómo se
// llama ese formato. Un selector de tipo obliga a clasificar antes de poder
// importar, y clasificar mal da un error que no explica nada.
//
// La detección se hace sobre el CONTENIDO y no sobre la extensión: una
// colección de Postman y un entorno de Postman son los dos `.json`, y el
// archivo que alguien renombró sigue siendo lo que era.

// ImportKind es qué resultó ser el contenido.
type ImportKind string

const (
	ImportUnknown            ImportKind = ""
	ImportCurl               ImportKind = "curl"
	ImportRawHTTP            ImportKind = "raw-http"
	ImportURL                ImportKind = "url"
	ImportPostmanCollection  ImportKind = "postman-collection"
	ImportPostmanEnvironment ImportKind = "postman-environment"
	ImportPostmanDump        ImportKind = "postman-dump"
)

// ImportDetection es lo que se detectó, con lo suficiente para poder decirlo
// en pantalla ANTES de escribir nada. El diálogo lo muestra como «Se detectó:
// colección de Postman · 23 peticiones»: importar a ciegas y descubrir
// después qué entró es lo que hace que uno no se anime a arrastrar un archivo
// que no recuerda qué tenía.
type ImportDetection struct {
	Kind ImportKind `json:"kind"`
	// Label es el nombre del formato en español, para mostrar.
	Label string `json:"label"`
	// Name es el nombre que trae adentro (la colección, el entorno) o el
	// host de la URL. Vacío si el formato no nombra nada.
	Name string `json:"name,omitempty"`
	// Method y URL solo vienen en lo que es UNA petición.
	Method string `json:"method,omitempty"`
	URL    string `json:"url,omitempty"`
	// Conteos de lo que traería una colección o un volcado.
	Requests    int `json:"requests,omitempty"`
	Folders     int `json:"folders,omitempty"`
	Variables   int `json:"variables,omitempty"`
	Collections int `json:"collections,omitempty"`
	// Reason explica por qué NO se pudo reconocer, cuando Kind es
	// ImportUnknown. Un «no se reconoce el formato» pelado deja a quien pegó
	// algo sin nada que corregir.
	Reason string `json:"reason,omitempty"`
}

// DetectImport clasifica un contenido pegado o leído de un archivo.
//
// El orden importa: primero JSON —que es lo único que se puede confirmar
// leyendo su estructura— y después las formas de texto, de la más específica
// (un comando cURL empieza con `curl`) a la más laxa (cualquier cosa que
// parezca una URL).
func DetectImport(data []byte) ImportDetection {
	text := strings.TrimSpace(string(data))
	if text == "" {
		return ImportDetection{Reason: "no hay nada que importar"}
	}

	if strings.HasPrefix(text, "{") || strings.HasPrefix(text, "[") {
		return detectJSON([]byte(text))
	}
	if looksLikeCurl(text) {
		if req, err := ParseCurl(text); err == nil {
			return ImportDetection{Kind: ImportCurl, Label: "comando cURL", Method: req.Method, URL: req.URL}
		} else {
			return ImportDetection{Reason: "parece un comando cURL pero no se pudo leer: " + err.Error()}
		}
	}
	if req, err := ParseRawHTTP(text); err == nil {
		return ImportDetection{Kind: ImportRawHTTP, Label: "petición HTTP en texto", Method: req.Method, URL: req.URL}
	}
	if u, ok := bareURL(text); ok {
		return ImportDetection{Kind: ImportURL, Label: "URL", Method: "GET", URL: text, Name: u.Host}
	}
	return ImportDetection{Reason: "no se reconoce: no es JSON de Postman, ni un comando cURL, ni una petición en texto, ni una URL"}
}

func detectJSON(data []byte) ImportDetection {
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(data, &doc); err != nil {
		return ImportDetection{Reason: "el JSON no se pudo leer: " + err.Error()}
	}

	// Volcado completo de datos de Postman (Settings → Data → Export). Trae
	// las colecciones y los entornos juntos en un solo archivo.
	if raw, ok := doc["collections"]; ok {
		var cols []json.RawMessage
		if json.Unmarshal(raw, &cols) == nil {
			out := ImportDetection{Kind: ImportPostmanDump, Label: "volcado de datos de Postman", Collections: len(cols)}
			for _, c := range cols {
				sub := detectJSON(c)
				out.Requests += sub.Requests
				out.Folders += sub.Folders
			}
			if env, ok := doc["environments"]; ok {
				var envs []json.RawMessage
				if json.Unmarshal(env, &envs) == nil {
					out.Variables = len(envs)
				}
			}
			return out
		}
	}

	// Entorno de Postman: nombre + values, sin `item`. Se mira ANTES que la
	// colección porque los dos traen `name`, y solo la colección trae `item`.
	if _, hasItem := doc["item"]; !hasItem {
		if raw, ok := doc["values"]; ok {
			var vals []json.RawMessage
			if json.Unmarshal(raw, &vals) == nil {
				return ImportDetection{
					Kind:      ImportPostmanEnvironment,
					Label:     "entorno de Postman",
					Name:      jsonString(doc["name"]),
					Variables: len(vals),
				}
			}
		}
	}

	if _, ok := doc["info"]; ok {
		col, err := ParsePostman(data)
		if err != nil {
			return ImportDetection{Reason: err.Error()}
		}
		reqs, folders := countItems(col.Items)
		return ImportDetection{
			Kind: ImportPostmanCollection, Label: "colección de Postman",
			Name: col.Name, Requests: reqs, Folders: folders, Variables: len(col.Variables),
		}
	}

	// Colección v1: `requests` sueltas y sin `info`. Se reconoce para poder
	// decir qué hacer — el formato cambió en 2016 y Postman sigue pudiendo
	// convertirlo, pero nada de eso se adivina desde un "no se reconoce".
	if _, ok := doc["requests"]; ok {
		return ImportDetection{Reason: "es una colección de Postman v1: abrila en Postman y exportala como v2.1"}
	}
	return ImportDetection{Reason: "es JSON, pero no una colección ni un entorno de Postman (le falta info.name)"}
}

func countItems(items []ImportedItem) (requests, folders int) {
	for _, it := range items {
		if it.Kind == "folder" {
			folders++
			r, f := countItems(it.Children)
			requests += r
			folders += f
			continue
		}
		requests++
	}
	return requests, folders
}

func jsonString(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	return ""
}

func looksLikeCurl(text string) bool {
	head := strings.TrimLeft(text, "$ ")
	return strings.HasPrefix(strings.ToLower(head), "curl ") || strings.HasPrefix(strings.ToLower(head), "curl\n")
}

func bareURL(text string) (*url.URL, bool) {
	if strings.ContainsAny(text, " \t\n") {
		return nil, false
	}
	u, err := url.Parse(text)
	if err != nil || u.Host == "" {
		return nil, false
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, false
	}
	return u, true
}

// SplitPostmanDump parte un volcado de datos de Postman (Settings → Data →
// Export) en sus colecciones y sus entornos, sin interpretarlos: cada trozo
// vuelve a pasar por la misma detección que un archivo suelto, así que el
// volcado no necesita su propio traductor.
func SplitPostmanDump(data []byte) (collections, environments []json.RawMessage, err error) {
	var doc struct {
		Collections  []json.RawMessage `json:"collections"`
		Environments []json.RawMessage `json:"environments"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, nil, fmt.Errorf("el volcado no se pudo leer: %w", err)
	}
	if len(doc.Collections) == 0 && len(doc.Environments) == 0 {
		return nil, nil, fmt.Errorf("el volcado no trae colecciones ni entornos")
	}
	return doc.Collections, doc.Environments, nil
}

// ImportedEnvironment es un entorno de Postman ya traducido.
type ImportedEnvironment struct {
	Name      string     `json:"name"`
	Variables []Variable `json:"variables,omitempty"`
}

// ParsePostmanEnvironment traduce el JSON de un entorno exportado.
//
// Un entorno de Postman y las variables de una colección tienen la misma
// forma (`key`, `value`, `type`, `enabled`), así que se reusa el mismo
// traductor: lo que cambia es dónde vive la lista (`values` contra
// `variable`) y que el entorno marca lo deshabilitado con `enabled: false` en
// vez de con `disabled: true`.
func ParsePostmanEnvironment(data []byte) (*ImportedEnvironment, error) {
	var doc struct {
		Name   string `json:"name"`
		Values []struct {
			Key     string `json:"key"`
			Value   any    `json:"value"`
			Type    string `json:"type"`
			Enabled *bool  `json:"enabled"`
		} `json:"values"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, fmt.Errorf("el entorno no es JSON válido: %w", err)
	}
	if strings.TrimSpace(doc.Name) == "" {
		return nil, fmt.Errorf("no parece un entorno de Postman: le falta el nombre")
	}

	out := &ImportedEnvironment{Name: doc.Name}
	for _, v := range doc.Values {
		value := ""
		if s, ok := v.Value.(string); ok {
			value = s
		} else if v.Value != nil {
			value = fmt.Sprint(v.Value)
		}
		// Ausente se lee como habilitada: los exports viejos no traen el
		// campo, y leerlos como deshabilitadas importaría un entorno entero
		// en gris.
		enabled := v.Enabled == nil || *v.Enabled
		out.Variables = append(out.Variables, Variable{
			Key: v.Key, Value: value, Enabled: enabled, Secret: v.Type == "secret",
		})
	}
	return out, nil
}

// Métodos aceptados en la primera línea de una petición en texto. La lista es
// cerrada a propósito: sin ella, cualquier línea de dos palabras seguida de
// dos puntos —una nota pegada por error, un log— se leería como una petición.
var rawHTTPMethods = map[string]bool{
	"GET": true, "POST": true, "PUT": true, "PATCH": true, "DELETE": true,
	"HEAD": true, "OPTIONS": true, "TRACE": true, "CONNECT": true,
}

// ParseRawHTTP traduce una petición escrita en texto plano, tal como aparece
// en la documentación de una API, en un ticket o en la pestaña «Raw» de las
// herramientas del navegador:
//
//	POST /api/v1/pedidos HTTP/1.1
//	Host: api.ejemplo.com
//	Content-Type: application/json
//
//	{"total": 120}
//
// La línea `HTTP/1.1` es opcional y la ruta puede venir absoluta, que es como
// la escribe la mayoría de la documentación.
func ParseRawHTTP(text string) (Request, error) {
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	i := 0
	for i < len(lines) && strings.TrimSpace(lines[i]) == "" {
		i++
	}
	if i == len(lines) {
		return Request{}, fmt.Errorf("no hay nada que importar")
	}

	fields := strings.Fields(strings.TrimSpace(lines[i]))
	if len(fields) < 2 {
		return Request{}, fmt.Errorf("la primera línea no tiene la forma «MÉTODO ruta»")
	}
	method := strings.ToUpper(fields[0])
	if !rawHTTPMethods[method] {
		return Request{}, fmt.Errorf("%q no es un método HTTP", fields[0])
	}
	target := fields[1]
	i++

	req := Request{Method: method, Settings: DefaultSettings(), Body: Body{Mode: BodyNone}, Auth: Auth{Type: AuthInherit}}
	host := ""
	for ; i < len(lines); i++ {
		line := lines[i]
		if strings.TrimSpace(line) == "" {
			i++
			break
		}
		idx := strings.Index(line, ":")
		if idx <= 0 {
			return Request{}, fmt.Errorf("la línea %q no es un header", strings.TrimSpace(line))
		}
		key := strings.TrimSpace(line[:idx])
		value := strings.TrimSpace(line[idx+1:])
		if strings.EqualFold(key, "host") {
			host = value
			// El Host no se guarda como header: ya está en la URL, y
			// mandarlo dos veces es la forma de que una petición importada
			// llegue a otro servidor del que dice la barra de direcciones.
			continue
		}
		req.Headers = append(req.Headers, KeyValue{Key: key, Value: value, Enabled: true})
	}

	if strings.HasPrefix(target, "/") {
		if host == "" {
			return Request{}, fmt.Errorf("la ruta es relativa y no hay header Host del que sacar el servidor")
		}
		req.URL = rawHTTPScheme(host) + "://" + host + target
	} else {
		req.URL = target
		if !strings.Contains(target, "://") && host != "" && !strings.HasPrefix(target, "{{") {
			req.URL = rawHTTPScheme(host) + "://" + target
		}
	}

	if i < len(lines) {
		body := strings.TrimRight(strings.Join(lines[i:], "\n"), "\n")
		if strings.TrimSpace(body) != "" {
			req.Body = Body{Mode: BodyRaw, Raw: body, RawLang: guessBodyLang(body, req.Headers)}
		}
	}
	return req, nil
}

// rawHTTPScheme elige el esquema cuando el texto no lo dice. Una petición en
// texto plano no lleva esa información —`HTTP/1.1` es la versión del
// protocolo, no si va cifrado—, así que se asume TLS salvo en lo que
// claramente es una máquina local o el puerto 80.
func rawHTTPScheme(host string) string {
	h := strings.ToLower(host)
	if strings.HasPrefix(h, "localhost") || strings.HasPrefix(h, "127.0.0.1") ||
		strings.HasPrefix(h, "[::1]") || strings.HasSuffix(h, ":80") {
		return "http"
	}
	return "https"
}
