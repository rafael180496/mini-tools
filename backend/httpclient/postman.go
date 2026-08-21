package httpclient

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Import y export del formato de colección de Postman v2.1.
//
// # La promesa: round-trip sin pérdida
//
// Este paquete modela lo que sabe ejecutar, que es bastante menos de lo que
// el formato admite: respuestas de ejemplo guardadas,
// `protocolProfileBehavior`, autenticaciones que no firmamos, campos que
// Postman agregue mañana. Todo eso se guarda CRUDO junto a cada ítem y se
// reinyecta al exportar.
//
// Sin esa preservación, "compatible con Postman" sería una verdad a medias:
// importás una colección de 23 peticiones con sus ejemplos y la exportás
// convertida en 23 peticiones peladas. El costo es una columna cifrada más
// por ítem; la alternativa era perder datos del usuario en silencio.
//
// # Qué NO se intenta
//
// No se traduce el `raw` de la URL a nuestra estructura y de vuelta. Postman
// guarda la URL tres veces (raw, host[]+path[], y query[]) y mantener las
// tres sincronizadas al exportar es una fuente de discrepancias silenciosas.
// Se usa `raw` como fuente de verdad y se reconstruye a partir de ella.

// ImportedItem es un nodo del árbol ya traducido a nuestro modelo.
type ImportedItem struct {
	Kind       string     `json:"kind"` // "folder" | "request"
	Name       string     `json:"name"`
	Method     string     `json:"method,omitempty"`
	URL        string     `json:"url,omitempty"`
	Params     []KeyValue `json:"params,omitempty"`
	PathVars   []KeyValue `json:"pathVars,omitempty"`
	Headers    []KeyValue `json:"headers,omitempty"`
	Body       Body       `json:"body"`
	Auth       Auth       `json:"auth"`
	Docs       string     `json:"docs,omitempty"`
	PreRequest string     `json:"preRequest,omitempty"`
	TestScript string     `json:"testScript,omitempty"`
	// Raw es el JSON original de este ítem, para poder devolverlo intacto.
	Raw      string         `json:"raw,omitempty"`
	Children []ImportedItem `json:"children,omitempty"`
}

// ImportedCollection es una colección traducida.
type ImportedCollection struct {
	Name        string         `json:"name"`
	Description string         `json:"description,omitempty"`
	Variables   []Variable     `json:"variables,omitempty"`
	Auth        Auth           `json:"auth"`
	PreRequest  string         `json:"preRequest,omitempty"`
	TestScript  string         `json:"testScript,omitempty"`
	Raw         string         `json:"raw,omitempty"`
	Items       []ImportedItem `json:"items,omitempty"`
	// Warnings son cosas que se importaron pero no se van a ejecutar, para
	// poder decirlo en vez de que el usuario lo descubra al mandar.
	Warnings []string `json:"warnings,omitempty"`
}

// ParsePostman traduce el JSON de una colección exportada de Postman.
func ParsePostman(data []byte) (*ImportedCollection, error) {
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, fmt.Errorf("el archivo no es JSON válido: %w", err)
	}

	var info struct {
		Name        string `json:"name"`
		Description any    `json:"description"`
		Schema      string `json:"schema"`
	}
	if raw, ok := doc["info"]; ok {
		_ = json.Unmarshal(raw, &info)
	}
	if info.Name == "" {
		return nil, fmt.Errorf("no parece una colección de Postman: le falta info.name")
	}

	out := &ImportedCollection{Name: info.Name, Description: describe(info.Description)}

	// El schema se avisa pero no se rechaza: una colección v2.0 comparte casi
	// toda la estructura con la v2.1, y negarse a abrirla por un número
	// sería peor que importarla y decir que puede haber diferencias.
	if info.Schema != "" && !strings.Contains(info.Schema, "v2.1") && !strings.Contains(info.Schema, "v2.0") {
		out.Warnings = append(out.Warnings, "el archivo declara un esquema desconocido ("+info.Schema+"); se importó igual")
	}

	// La colección cruda, SIN los ítems: esos llevan su propio raw y
	// duplicarlos acá multiplicaría el tamaño guardado.
	if bare, err := json.Marshal(withoutKeys(doc, "item")); err == nil {
		out.Raw = string(bare)
	}

	if raw, ok := doc["variable"]; ok {
		out.Variables = parsePostmanVariables(raw)
	}
	if raw, ok := doc["auth"]; ok {
		out.Auth = parsePostmanAuth(raw, &out.Warnings)
	}
	if raw, ok := doc["event"]; ok {
		out.PreRequest, out.TestScript = parsePostmanEvents(raw)
	}

	if raw, ok := doc["item"]; ok {
		var items []json.RawMessage
		if err := json.Unmarshal(raw, &items); err != nil {
			return nil, fmt.Errorf("la lista de peticiones no se pudo leer: %w", err)
		}
		for _, it := range items {
			parsed, err := parsePostmanItem(it, &out.Warnings)
			if err != nil {
				// Un ítem ilegible no puede tumbar la importación entera:
				// se avisa y se sigue con los otros veintidós.
				out.Warnings = append(out.Warnings, "se omitió un elemento ilegible: "+err.Error())
				continue
			}
			out.Items = append(out.Items, parsed)
		}
	}
	if len(out.Items) == 0 {
		return nil, fmt.Errorf("la colección %q no trae ninguna petición", info.Name)
	}
	return out, nil
}

func parsePostmanItem(raw json.RawMessage, warnings *[]string) (ImportedItem, error) {
	var node map[string]json.RawMessage
	if err := json.Unmarshal(raw, &node); err != nil {
		return ImportedItem{}, err
	}

	var name string
	if v, ok := node["name"]; ok {
		_ = json.Unmarshal(v, &name)
	}
	item := ImportedItem{Name: name, Raw: string(raw)}
	if item.Name == "" {
		item.Name = "Sin nombre"
	}

	// Una carpeta es un ítem que contiene ítems. Es la única diferencia que
	// hace el formato, y por eso nuestro modelo la copia.
	if sub, ok := node["item"]; ok {
		item.Kind = "folder"
		var children []json.RawMessage
		if err := json.Unmarshal(sub, &children); err == nil {
			for _, c := range children {
				parsed, err := parsePostmanItem(c, warnings)
				if err != nil {
					*warnings = append(*warnings, "se omitió un elemento ilegible dentro de «"+item.Name+"»")
					continue
				}
				item.Children = append(item.Children, parsed)
			}
		}
		if ev, ok := node["event"]; ok {
			item.PreRequest, item.TestScript = parsePostmanEvents(ev)
		}
		if au, ok := node["auth"]; ok {
			item.Auth = parsePostmanAuth(au, warnings)
		}
		return item, nil
	}

	item.Kind = "request"
	if ev, ok := node["event"]; ok {
		item.PreRequest, item.TestScript = parsePostmanEvents(ev)
	}

	reqRaw, ok := node["request"]
	if !ok {
		return item, nil
	}
	// `request` puede ser un string (solo la URL) en colecciones viejas.
	var asString string
	if err := json.Unmarshal(reqRaw, &asString); err == nil {
		item.Method, item.URL = "GET", asString
		return item, nil
	}

	var req struct {
		Method      string          `json:"method"`
		Header      json.RawMessage `json:"header"`
		URL         json.RawMessage `json:"url"`
		Body        json.RawMessage `json:"body"`
		Auth        json.RawMessage `json:"auth"`
		Description any             `json:"description"`
	}
	if err := json.Unmarshal(reqRaw, &req); err != nil {
		return item, err
	}
	item.Method = strings.ToUpper(req.Method)
	if item.Method == "" {
		item.Method = "GET"
	}
	item.Docs = describe(req.Description)
	item.Headers = parsePostmanHeaders(req.Header)
	item.URL, item.Params, item.PathVars = parsePostmanURL(req.URL)
	item.Body = parsePostmanBody(req.Body, warnings, item.Name)
	if len(req.Auth) > 0 {
		item.Auth = parsePostmanAuth(req.Auth, warnings)
	}
	return item, nil
}

// parsePostmanURL acepta las dos formas del campo: un string, o el objeto
// con raw/host/path/query/variable.
//
// Se usa `raw` como fuente de verdad y se le quita la query, que pasa a la
// tabla de params — que es donde nuestro editor la muestra y la edita.
// Dejarla en los dos lados la duplicaría al enviar.
func parsePostmanURL(raw json.RawMessage) (string, []KeyValue, []KeyValue) {
	if len(raw) == 0 {
		return "", nil, nil
	}
	var asString string
	if err := json.Unmarshal(raw, &asString); err == nil {
		return asString, nil, nil
	}

	var u struct {
		Raw   string `json:"raw"`
		Query []struct {
			Key         string `json:"key"`
			Value       string `json:"value"`
			Disabled    bool   `json:"disabled"`
			Description any    `json:"description"`
		} `json:"query"`
		Variable []struct {
			Key         string `json:"key"`
			Value       string `json:"value"`
			Description any    `json:"description"`
		} `json:"variable"`
	}
	if err := json.Unmarshal(raw, &u); err != nil {
		return "", nil, nil
	}

	base := u.Raw
	if i := strings.Index(base, "?"); i >= 0 {
		base = base[:i]
	}

	var params []KeyValue
	for _, q := range u.Query {
		params = append(params, KeyValue{Key: q.Key, Value: q.Value, Enabled: !q.Disabled, Description: describe(q.Description)})
	}
	var pathVars []KeyValue
	for _, v := range u.Variable {
		pathVars = append(pathVars, KeyValue{Key: v.Key, Value: v.Value, Enabled: true, Description: describe(v.Description)})
	}
	return base, params, pathVars
}

func parsePostmanHeaders(raw json.RawMessage) []KeyValue {
	if len(raw) == 0 {
		return nil
	}
	var rows []struct {
		Key         string `json:"key"`
		Value       string `json:"value"`
		Disabled    bool   `json:"disabled"`
		Description any    `json:"description"`
	}
	if err := json.Unmarshal(raw, &rows); err != nil {
		return nil
	}
	out := make([]KeyValue, 0, len(rows))
	for _, r := range rows {
		out = append(out, KeyValue{Key: r.Key, Value: r.Value, Enabled: !r.Disabled, Description: describe(r.Description)})
	}
	return out
}

func parsePostmanBody(raw json.RawMessage, warnings *[]string, itemName string) Body {
	if len(raw) == 0 {
		return Body{Mode: BodyNone}
	}
	var b struct {
		Mode     string          `json:"mode"`
		Raw      string          `json:"raw"`
		Options  json.RawMessage `json:"options"`
		FormData []struct {
			Key      string `json:"key"`
			Value    string `json:"value"`
			Src      any    `json:"src"`
			Type     string `json:"type"`
			Disabled bool   `json:"disabled"`
		} `json:"formdata"`
		URLEncoded []struct {
			Key      string `json:"key"`
			Value    string `json:"value"`
			Disabled bool   `json:"disabled"`
		} `json:"urlencoded"`
		File struct {
			Src string `json:"src"`
		} `json:"file"`
		GraphQL struct {
			Query     string `json:"query"`
			Variables string `json:"variables"`
		} `json:"graphql"`
	}
	if err := json.Unmarshal(raw, &b); err != nil {
		return Body{Mode: BodyNone}
	}

	switch b.Mode {
	case "raw":
		lang := "text"
		// El lenguaje vive en options.raw.language, que es donde Postman
		// guarda si el cuerpo es JSON o XML — sin eso el resaltado y el
		// Content-Type saldrían mal.
		var opts struct {
			Raw struct {
				Language string `json:"language"`
			} `json:"raw"`
		}
		if len(b.Options) > 0 && json.Unmarshal(b.Options, &opts) == nil && opts.Raw.Language != "" {
			lang = opts.Raw.Language
		}
		return Body{Mode: BodyRaw, Raw: b.Raw, RawLang: lang}

	case "formdata":
		out := Body{Mode: BodyFormData}
		for _, f := range b.FormData {
			field := FormField{Key: f.Key, Value: f.Value, Type: f.Type, Enabled: !f.Disabled}
			if field.Type == "" {
				field.Type = "text"
			}
			// `src` puede ser un string o una lista de rutas; nos quedamos
			// con la primera, que es lo que sabemos mandar.
			if field.Type == "file" {
				switch v := f.Src.(type) {
				case string:
					field.Value = v
				case []any:
					if len(v) > 0 {
						if s, ok := v[0].(string); ok {
							field.Value = s
						}
					}
				}
				if field.Value == "" {
					*warnings = append(*warnings, "«"+itemName+"» sube un archivo cuya ruta no vino en el export: hay que elegirlo de nuevo")
				}
			}
			out.FormData = append(out.FormData, field)
		}
		return out

	case "urlencoded":
		out := Body{Mode: BodyURLEncoded}
		for _, f := range b.URLEncoded {
			out.URLEncoded = append(out.URLEncoded, KeyValue{Key: f.Key, Value: f.Value, Enabled: !f.Disabled})
		}
		return out

	case "file":
		if b.File.Src == "" {
			*warnings = append(*warnings, "«"+itemName+"» manda un archivo como cuerpo, pero el export no trae la ruta: hay que elegirlo de nuevo")
		}
		return Body{Mode: BodyBinary, BinaryPath: b.File.Src}

	case "graphql":
		return Body{Mode: BodyGraphQL, GraphQLQuery: b.GraphQL.Query, GraphQLVariables: b.GraphQL.Variables}

	default:
		return Body{Mode: BodyNone}
	}
}

// parsePostmanAuth traduce el bloque de autenticación.
//
// Postman guarda los parámetros como una lista de pares por tipo
// (`auth.basic[] = [{key:"username", value:"..."}]`), así que se aplana a un
// mapa y de ahí a nuestros campos.
func parsePostmanAuth(raw json.RawMessage, warnings *[]string) Auth {
	if len(raw) == 0 {
		return Auth{Type: AuthInherit}
	}
	var wrapper map[string]json.RawMessage
	if err := json.Unmarshal(raw, &wrapper); err != nil {
		return Auth{Type: AuthInherit}
	}
	var kind string
	if v, ok := wrapper["type"]; ok {
		_ = json.Unmarshal(v, &kind)
	}
	if kind == "" || kind == "noauth" {
		if kind == "noauth" {
			return Auth{Type: AuthNone}
		}
		return Auth{Type: AuthInherit}
	}

	params := map[string]string{}
	if rows, ok := wrapper[kind]; ok {
		var list []struct {
			Key   string `json:"key"`
			Value any    `json:"value"`
		}
		if json.Unmarshal(rows, &list) == nil {
			for _, r := range list {
				if s, ok := r.Value.(string); ok {
					params[r.Key] = s
				} else if r.Value != nil {
					params[r.Key] = fmt.Sprint(r.Value)
				}
			}
		}
	}

	out := Auth{Type: kind, Raw: string(raw)}
	switch kind {
	case "basic", "digest", "ntlm":
		out.Username, out.Password = params["username"], params["password"]
	case "bearer":
		out.Token = params["token"]
	case "apikey":
		out.Key, out.Value, out.In = params["key"], params["value"], params["in"]
	case "jwt":
		out.Algorithm, out.Secret, out.Payload = params["algorithm"], params["secret"], params["payload"]
		out.SecretBase64 = params["isSecretBase64Encoded"] == "true"
		out.HeaderPrefix, out.AddTokenTo, out.QueryParamName = params["headerPrefix"], params["addTokenTo"], params["queryParamName"]
	case "awsv4":
		out.AccessKey, out.SecretKey = params["accessKey"], params["secretKey"]
		out.SessionToken, out.Region, out.Service = params["sessionToken"], params["region"], params["service"]
	case "oauth2":
		out.GrantType, out.AccessTokenURL, out.AuthURL = params["grant_type"], params["accessTokenUrl"], params["authUrl"]
		out.ClientID, out.ClientSecret, out.Scope = params["clientId"], params["clientSecret"], params["scope"]
		out.RefreshToken, out.RedirectURI, out.AccessToken = params["refreshToken"], params["redirect_uri"], params["accessToken"]
	}

	if !out.Executable() {
		*warnings = append(*warnings, "la autenticación «"+kind+"» se importó y se va a exportar intacta, pero esta versión no la firma")
	}
	return out
}

// parsePostmanEvents saca los scripts. `exec` es una lista de líneas, no un
// texto: unirlas con salto de línea es lo que las vuelve legibles.
func parsePostmanEvents(raw json.RawMessage) (pre, test string) {
	var events []struct {
		Listen string `json:"listen"`
		Script struct {
			Exec any `json:"exec"`
		} `json:"script"`
	}
	if err := json.Unmarshal(raw, &events); err != nil {
		return "", ""
	}
	for _, e := range events {
		text := joinExec(e.Script.Exec)
		if strings.TrimSpace(text) == "" {
			continue
		}
		switch e.Listen {
		case "prerequest":
			pre = text
		case "test":
			test = text
		}
	}
	return pre, test
}

func joinExec(exec any) string {
	switch v := exec.(type) {
	case string:
		return v
	case []any:
		lines := make([]string, 0, len(v))
		for _, l := range v {
			if s, ok := l.(string); ok {
				lines = append(lines, s)
			}
		}
		return strings.Join(lines, "\n")
	}
	return ""
}

func parsePostmanVariables(raw json.RawMessage) []Variable {
	var rows []struct {
		Key      string `json:"key"`
		Value    any    `json:"value"`
		Type     string `json:"type"`
		Disabled bool   `json:"disabled"`
	}
	if err := json.Unmarshal(raw, &rows); err != nil {
		return nil
	}
	out := make([]Variable, 0, len(rows))
	for _, r := range rows {
		value := ""
		if s, ok := r.Value.(string); ok {
			value = s
		} else if r.Value != nil {
			value = fmt.Sprint(r.Value)
		}
		out = append(out, Variable{
			Key: r.Key, Value: value, Enabled: !r.Disabled,
			// Postman marca los secretos con type "secret"; respetarlo es
			// lo que hace que un token importado quede cifrado y fuera del
			// export siguiente, en vez de en claro.
			Secret: r.Type == "secret",
		})
	}
	return out
}

// describe normaliza el campo description, que Postman guarda como string o
// como objeto {content, type}.
func describe(v any) string {
	switch d := v.(type) {
	case string:
		return d
	case map[string]any:
		if s, ok := d["content"].(string); ok {
			return s
		}
	}
	return ""
}

func withoutKeys(m map[string]json.RawMessage, drop ...string) map[string]json.RawMessage {
	out := make(map[string]json.RawMessage, len(m))
	for k, v := range m {
		skip := false
		for _, d := range drop {
			if k == d {
				skip = true
				break
			}
		}
		if !skip {
			out[k] = v
		}
	}
	return out
}

// --- Export ------------------------------------------------------------------

// BuildPostman reconstruye el JSON de una colección en formato v2.1.
//
// La estrategia es "partir del crudo y pisar lo modelado": cada ítem se
// parte de su JSON original y solo se sobreescriben los campos que esta
// aplicación entiende. Todo lo demás —las respuestas de ejemplo guardadas,
// `protocolProfileBehavior`, cualquier campo que Postman agregue— sobrevive
// sin que este código tenga que conocerlo.
//
// El round-trip NO es byte a byte, y no se promete que lo sea: la URL se
// reconstruye desde `raw` (que es la fuente de verdad elegida), así que los
// `host[]`/`path[]` redundantes que Postman guarda se recalculan al
// importar de nuevo. Lo que se promete es que no se pierde ningún ítem ni
// ningún dato.
func BuildPostman(col ImportedCollection) ([]byte, error) {
	doc := map[string]json.RawMessage{}
	if strings.TrimSpace(col.Raw) != "" {
		// El crudo de la colección trae info._postman_id, el schema y
		// cualquier otra cosa; conservarlo mantiene la identidad del archivo.
		_ = json.Unmarshal([]byte(col.Raw), &doc)
	}
	if _, ok := doc["info"]; !ok {
		info := map[string]string{
			"name":   col.Name,
			"schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
		}
		if col.Description != "" {
			info["description"] = col.Description
		}
		doc["info"] = mustJSON(info)
	} else {
		// El nombre puede haber cambiado en la aplicación: se pisa dentro
		// del info existente para no perder el resto.
		var info map[string]json.RawMessage
		if json.Unmarshal(doc["info"], &info) == nil {
			info["name"] = mustJSON(col.Name)
			if col.Description != "" {
				info["description"] = mustJSON(col.Description)
			}
			doc["info"] = mustJSON(info)
		}
	}

	if len(col.Variables) > 0 {
		doc["variable"] = mustJSON(exportVariables(col.Variables))
	} else {
		delete(doc, "variable")
	}

	if auth := exportAuth(col.Auth); auth != nil {
		doc["auth"] = auth
	} else {
		delete(doc, "auth")
	}

	if ev := exportEvents(col.PreRequest, col.TestScript); ev != nil {
		doc["event"] = ev
	} else {
		delete(doc, "event")
	}

	items := make([]json.RawMessage, 0, len(col.Items))
	for _, it := range col.Items {
		encoded, err := exportItem(it)
		if err != nil {
			return nil, err
		}
		items = append(items, encoded)
	}
	doc["item"] = mustJSON(items)

	return json.MarshalIndent(doc, "", "\t")
}

func exportItem(it ImportedItem) (json.RawMessage, error) {
	node := map[string]json.RawMessage{}
	if strings.TrimSpace(it.Raw) != "" {
		_ = json.Unmarshal([]byte(it.Raw), &node)
	}
	node["name"] = mustJSON(it.Name)

	if ev := exportEvents(it.PreRequest, it.TestScript); ev != nil {
		node["event"] = ev
	} else {
		delete(node, "event")
	}

	if it.Kind == "folder" {
		children := make([]json.RawMessage, 0, len(it.Children))
		for _, c := range it.Children {
			encoded, err := exportItem(c)
			if err != nil {
				return nil, err
			}
			children = append(children, encoded)
		}
		node["item"] = mustJSON(children)
		// Una carpeta no lleva request: si el crudo venía de una petición
		// convertida, hay que sacarlo o el archivo queda ambiguo.
		delete(node, "request")
		if auth := exportAuth(it.Auth); auth != nil {
			node["auth"] = auth
		} else {
			delete(node, "auth")
		}
		return mustJSON(node), nil
	}

	// Se parte del request original para conservar lo que no modelamos.
	req := map[string]json.RawMessage{}
	if raw, ok := node["request"]; ok {
		_ = json.Unmarshal(raw, &req)
	}
	req["method"] = mustJSON(strings.ToUpper(it.Method))
	req["header"] = mustJSON(exportKeyValues(it.Headers))
	req["url"] = mustJSON(exportURL(it))
	if it.Docs != "" {
		req["description"] = mustJSON(it.Docs)
	} else {
		delete(req, "description")
	}
	if body := exportBody(it.Body); body != nil {
		req["body"] = body
	} else {
		delete(req, "body")
	}
	if auth := exportAuth(it.Auth); auth != nil {
		req["auth"] = auth
	} else {
		delete(req, "auth")
	}
	node["request"] = mustJSON(req)
	delete(node, "item")
	return mustJSON(node), nil
}

// exportURL emite la forma de objeto con `raw` reconstruida a partir de la
// URL y los params habilitados — que es exactamente lo que se va a enviar.
func exportURL(it ImportedItem) map[string]any {
	raw := it.URL
	var query []map[string]any
	for _, p := range it.Params {
		if p.Key == "" {
			continue
		}
		row := map[string]any{"key": p.Key, "value": p.Value}
		if !p.Enabled {
			row["disabled"] = true
		}
		if p.Description != "" {
			row["description"] = p.Description
		}
		query = append(query, row)
	}
	if len(query) > 0 {
		parts := make([]string, 0, len(query))
		for _, p := range it.Params {
			if p.Enabled && p.Key != "" {
				parts = append(parts, p.Key+"="+p.Value)
			}
		}
		if len(parts) > 0 {
			raw += "?" + strings.Join(parts, "&")
		}
	}

	out := map[string]any{"raw": raw}
	if len(query) > 0 {
		out["query"] = query
	}
	var variables []map[string]any
	for _, v := range it.PathVars {
		if v.Key == "" {
			continue
		}
		variables = append(variables, map[string]any{"key": v.Key, "value": v.Value})
	}
	if len(variables) > 0 {
		out["variable"] = variables
	}
	return out
}

func exportKeyValues(rows []KeyValue) []map[string]any {
	out := make([]map[string]any, 0, len(rows))
	for _, r := range rows {
		if r.Key == "" {
			continue
		}
		row := map[string]any{"key": r.Key, "value": r.Value}
		if !r.Enabled {
			row["disabled"] = true
		}
		if r.Description != "" {
			row["description"] = r.Description
		}
		out = append(out, row)
	}
	return out
}

func exportBody(b Body) json.RawMessage {
	switch b.Mode {
	case BodyRaw:
		if b.Raw == "" {
			return nil
		}
		lang := b.RawLang
		if lang == "" {
			lang = "text"
		}
		return mustJSON(map[string]any{
			"mode": "raw", "raw": b.Raw,
			"options": map[string]any{"raw": map[string]any{"language": lang}},
		})
	case BodyFormData:
		rows := make([]map[string]any, 0, len(b.FormData))
		for _, f := range b.FormData {
			if f.Key == "" {
				continue
			}
			row := map[string]any{"key": f.Key, "type": f.Type}
			if f.Type == "file" {
				row["src"] = f.Value
			} else {
				row["value"] = f.Value
			}
			if !f.Enabled {
				row["disabled"] = true
			}
			rows = append(rows, row)
		}
		if len(rows) == 0 {
			return nil
		}
		return mustJSON(map[string]any{"mode": "formdata", "formdata": rows})
	case BodyURLEncoded:
		rows := exportKeyValues(b.URLEncoded)
		if len(rows) == 0 {
			return nil
		}
		return mustJSON(map[string]any{"mode": "urlencoded", "urlencoded": rows})
	case BodyBinary:
		if b.BinaryPath == "" {
			return nil
		}
		return mustJSON(map[string]any{"mode": "file", "file": map[string]any{"src": b.BinaryPath}})
	case BodyGraphQL:
		return mustJSON(map[string]any{"mode": "graphql", "graphql": map[string]any{
			"query": b.GraphQLQuery, "variables": b.GraphQLVariables,
		}})
	}
	return nil
}

// exportAuth reconstruye el bloque de autenticación.
//
// Para un tipo que no ejecutamos se devuelve el crudo tal cual: es la única
// forma de no perder parámetros que nuestro modelo no tiene campos para
// guardar. Para los que sí ejecutamos se reconstruye desde los campos, que
// es lo que hace que un token editado en la aplicación llegue al export.
func exportAuth(a Auth) json.RawMessage {
	if a.Type == "" || a.Type == AuthInherit {
		return nil
	}
	if a.Type == AuthNone {
		return mustJSON(map[string]any{"type": "noauth"})
	}
	if !a.Executable() {
		if strings.TrimSpace(a.Raw) != "" {
			return json.RawMessage(a.Raw)
		}
		return mustJSON(map[string]any{"type": a.Type})
	}

	pairs := func(kv ...[2]string) []map[string]any {
		out := make([]map[string]any, 0, len(kv))
		for _, p := range kv {
			if p[1] == "" {
				continue
			}
			out = append(out, map[string]any{"key": p[0], "value": p[1], "type": "string"})
		}
		return out
	}

	var rows []map[string]any
	switch a.Type {
	case AuthBasic, AuthDigest:
		rows = pairs([2]string{"username", a.Username}, [2]string{"password", a.Password})
	case AuthBearer:
		rows = pairs([2]string{"token", a.Token})
	case AuthAPIKey:
		rows = pairs([2]string{"key", a.Key}, [2]string{"value", a.Value}, [2]string{"in", a.In})
	case AuthJWT:
		rows = pairs([2]string{"algorithm", a.Algorithm}, [2]string{"secret", a.Secret},
			[2]string{"payload", a.Payload}, [2]string{"headerPrefix", a.HeaderPrefix},
			[2]string{"addTokenTo", a.AddTokenTo}, [2]string{"queryParamName", a.QueryParamName})
	case AuthAWSv4:
		rows = pairs([2]string{"accessKey", a.AccessKey}, [2]string{"secretKey", a.SecretKey},
			[2]string{"sessionToken", a.SessionToken}, [2]string{"region", a.Region}, [2]string{"service", a.Service})
	case AuthOAuth2:
		// El access token NO se exporta: es material de sesión, se vence, y
		// meterlo en un archivo que se comparte por chat es exactamente cómo
		// se filtra una credencial.
		rows = pairs([2]string{"grant_type", a.GrantType}, [2]string{"accessTokenUrl", a.AccessTokenURL},
			[2]string{"authUrl", a.AuthURL}, [2]string{"clientId", a.ClientID},
			[2]string{"clientSecret", a.ClientSecret}, [2]string{"scope", a.Scope},
			[2]string{"redirect_uri", a.RedirectURI})
	}
	return mustJSON(map[string]any{"type": a.Type, a.Type: rows})
}

func exportEvents(pre, test string) json.RawMessage {
	var events []map[string]any
	add := func(listen, script string) {
		if strings.TrimSpace(script) == "" {
			return
		}
		events = append(events, map[string]any{
			"listen": listen,
			"script": map[string]any{"type": "text/javascript", "exec": strings.Split(script, "\n")},
		})
	}
	add("prerequest", pre)
	add("test", test)
	if len(events) == 0 {
		return nil
	}
	return mustJSON(events)
}

// exportVariables omite el VALOR de las secretas.
//
// Es lo que hace Postman y es lo correcto: una colección exportada se manda
// por chat, se sube a un repositorio y se comparte con el equipo. La
// variable sigue declarada —para que quien la importe sepa que hace falta—
// pero vacía.
func exportVariables(vars []Variable) []map[string]any {
	out := make([]map[string]any, 0, len(vars))
	for _, v := range vars {
		if v.Key == "" {
			continue
		}
		row := map[string]any{"key": v.Key}
		if v.Secret {
			row["value"] = ""
			row["type"] = "secret"
		} else {
			row["value"] = v.Value
			row["type"] = "string"
		}
		if !v.Enabled {
			row["disabled"] = true
		}
		out = append(out, row)
	}
	return out
}

// mustJSON serializa algo que ya está en memoria y no puede fallar (mapas y
// slices de tipos serializables). Un error acá sería un bug de programación,
// no una condición de ejecución, y devolver un error por cada campo
// convertiría el exportador en una escalera de ifs.
func mustJSON(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		return json.RawMessage("null")
	}
	return b
}
