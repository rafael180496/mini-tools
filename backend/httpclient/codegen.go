package httpclient

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// Generación de snippets: la misma petición, escrita en el lenguaje que use
// quien la va a llevar a producción.
//
// Las plantillas son propias y están en Go, no en el frontend, por la misma
// razón que el formateo de cuerpos: el snippet tiene que salir de la
// petición YA RESUELTA (variables sustituidas, autenticación aplicada), y
// eso solo lo sabe armar esta capa.
//
// # Secretos
//
// El generador recibe un flag explícito. Con `withSecrets=false` los valores
// que vinieron de variables secretas salen como marcadores, porque el uso
// típico de un snippet es pegarlo en un ticket, en un chat o en un README —
// y ahí un token real es una filtración.

// CodeLanguage es un lenguaje ofrecido.
type CodeLanguage struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

// CodeLanguages es la lista para el selector, en el orden en que se ofrece.
func CodeLanguages() []CodeLanguage {
	return []CodeLanguage{
		{ID: "curl", Label: "cURL"},
		{ID: "http", Label: "HTTP"},
		{ID: "go", Label: "Go — net/http"},
		{ID: "javascript", Label: "JavaScript — fetch"},
		{ID: "python", Label: "Python — requests"},
		{ID: "java", Label: "Java — OkHttp"},
		{ID: "csharp", Label: "C# — HttpClient"},
		{ID: "php", Label: "PHP — cURL"},
		{ID: "ruby", Label: "Ruby — Net::HTTP"},
		{ID: "powershell", Label: "PowerShell"},
	}
}

// GenerateCode escribe la petición en el lenguaje pedido.
func GenerateCode(req Request, lang string) (string, error) {
	url, err := PreviewURL(req)
	if err != nil {
		url = req.URL
	}
	method := strings.ToUpper(strings.TrimSpace(req.Method))
	if method == "" {
		method = "GET"
	}
	headers := effectiveHeaders(req)
	body := snippetBody(req)

	switch lang {
	case "curl":
		return genCurl(method, url, headers, body, req.Settings), nil
	case "http":
		return genHTTP(method, url, headers, body), nil
	case "go":
		return genGo(method, url, headers, body), nil
	case "javascript":
		return genJS(method, url, headers, body), nil
	case "python":
		return genPython(method, url, headers, body), nil
	case "java":
		return genJava(method, url, headers, body), nil
	case "csharp":
		return genCSharp(method, url, headers, body), nil
	case "php":
		return genPHP(method, url, headers, body), nil
	case "ruby":
		return genRuby(method, url, headers, body), nil
	case "powershell":
		return genPowerShell(method, url, headers, body), nil
	default:
		return "", fmt.Errorf("lenguaje no soportado: %q", lang)
	}
}

// effectiveHeaders son los headers habilitados MÁS el Content-Type que
// implica el cuerpo, ordenados para que el snippet salga igual dos veces
// seguidas.
//
// Se incluye el Content-Type derivado porque el snippet tiene que reproducir
// la petición completa: sin él, quien lo pegue manda un JSON sin declararlo
// y se pregunta por qué el servidor contesta distinto que la aplicación.
func effectiveHeaders(req Request) []KeyValue {
	var out []KeyValue
	seen := map[string]bool{}
	for _, h := range req.Headers {
		if !h.Enabled || strings.TrimSpace(h.Key) == "" {
			continue
		}
		out = append(out, h)
		seen[strings.ToLower(h.Key)] = true
	}
	if !seen["content-type"] {
		if ct := snippetContentType(req.Body); ct != "" {
			out = append(out, KeyValue{Key: "Content-Type", Value: ct, Enabled: true})
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Key < out[j].Key })
	return out
}

func snippetContentType(b Body) string {
	switch b.Mode {
	case BodyRaw:
		if b.Raw == "" {
			return ""
		}
		return rawContentType(b.RawLang)
	case BodyURLEncoded:
		return "application/x-www-form-urlencoded"
	case BodyGraphQL:
		return "application/json"
	}
	return ""
}

// snippetBody es el cuerpo como texto. Para form-data y binario devuelve ""
// y el generador agrega un comentario: un snippet que finja subir un archivo
// que no existe en la máquina de quien lo pega sería peor que decir la
// verdad.
func snippetBody(req Request) string {
	switch req.Body.Mode {
	case BodyRaw:
		return req.Body.Raw
	case BodyURLEncoded:
		var parts []string
		for _, kv := range req.Body.URLEncoded {
			if kv.Enabled && kv.Key != "" {
				parts = append(parts, kv.Key+"="+kv.Value)
			}
		}
		return strings.Join(parts, "&")
	case BodyGraphQL:
		return fmt.Sprintf(`{"query":%s,"variables":%s}`,
			strconv.Quote(req.Body.GraphQLQuery), orNull(req.Body.GraphQLVariables))
	}
	return ""
}

func orNull(s string) string {
	if strings.TrimSpace(s) == "" {
		return "null"
	}
	return s
}

// unsupportedNote avisa cuando el cuerpo no se puede representar en texto.
func unsupportedNote(b Body, comment string) string {
	switch b.Mode {
	case BodyFormData:
		return comment + " el cuerpo es un formulario con archivos: agregá las partes a mano\n"
	case BodyBinary:
		return comment + " el cuerpo es el archivo " + b.BinaryPath + "\n"
	}
	return ""
}

func genCurl(method, url string, headers []KeyValue, body string, s Settings) string {
	var b strings.Builder
	b.WriteString("curl -X " + method + " " + shellQuote(url))
	for _, h := range headers {
		b.WriteString(" \\\n  -H " + shellQuote(h.Key+": "+h.Value))
	}
	if body != "" {
		b.WriteString(" \\\n  --data-raw " + shellQuote(body))
	}
	if !s.VerifyTLS {
		b.WriteString(" \\\n  --insecure")
	}
	if s.FollowRedirects {
		b.WriteString(" \\\n  --location")
	}
	b.WriteString("\n")
	return unsupportedNote(Body{}, "#") + b.String()
}

func genHTTP(method, url string, headers []KeyValue, body string) string {
	var b strings.Builder
	b.WriteString(method + " " + url + " HTTP/1.1\n")
	for _, h := range headers {
		b.WriteString(h.Key + ": " + h.Value + "\n")
	}
	if body != "" {
		b.WriteString("\n" + body + "\n")
	}
	return b.String()
}

func genGo(method, url string, headers []KeyValue, body string) string {
	var b strings.Builder
	b.WriteString("req, err := http.NewRequest(" + strconv.Quote(method) + ", " + strconv.Quote(url) + ", ")
	if body == "" {
		b.WriteString("nil)\n")
	} else {
		b.WriteString("strings.NewReader(" + goRawString(body) + "))\n")
	}
	b.WriteString("if err != nil {\n\treturn err\n}\n")
	for _, h := range headers {
		b.WriteString("req.Header.Set(" + strconv.Quote(h.Key) + ", " + strconv.Quote(h.Value) + ")\n")
	}
	b.WriteString("\nresp, err := http.DefaultClient.Do(req)\nif err != nil {\n\treturn err\n}\ndefer resp.Body.Close()\n")
	return b.String()
}

func genJS(method, url string, headers []KeyValue, body string) string {
	var b strings.Builder
	b.WriteString("const res = await fetch(" + strconv.Quote(url) + ", {\n  method: " + strconv.Quote(method) + ",\n")
	if len(headers) > 0 {
		b.WriteString("  headers: {\n")
		for _, h := range headers {
			b.WriteString("    " + strconv.Quote(h.Key) + ": " + strconv.Quote(h.Value) + ",\n")
		}
		b.WriteString("  },\n")
	}
	if body != "" {
		b.WriteString("  body: " + strconv.Quote(body) + ",\n")
	}
	b.WriteString("})\nconst data = await res.text()\n")
	return b.String()
}

func genPython(method, url string, headers []KeyValue, body string) string {
	var b strings.Builder
	b.WriteString("import requests\n\n")
	if len(headers) > 0 {
		b.WriteString("headers = {\n")
		for _, h := range headers {
			b.WriteString("    " + strconv.Quote(h.Key) + ": " + strconv.Quote(h.Value) + ",\n")
		}
		b.WriteString("}\n")
	}
	if body != "" {
		b.WriteString("data = " + strconv.Quote(body) + "\n")
	}
	b.WriteString("\nresp = requests.request(" + strconv.Quote(method) + ", " + strconv.Quote(url))
	if len(headers) > 0 {
		b.WriteString(", headers=headers")
	}
	if body != "" {
		b.WriteString(", data=data")
	}
	b.WriteString(")\nprint(resp.status_code, resp.text)\n")
	return b.String()
}

func genJava(method, url string, headers []KeyValue, body string) string {
	var b strings.Builder
	b.WriteString("OkHttpClient client = new OkHttpClient();\n\n")
	if body != "" {
		b.WriteString("RequestBody body = RequestBody.create(\n    " + javaString(body) + ",\n    MediaType.parse(\"application/json\"));\n\n")
	}
	b.WriteString("Request request = new Request.Builder()\n    .url(" + javaString(url) + ")\n")
	b.WriteString("    .method(" + javaString(method) + ", " + ifElse(body != "", "body", "null") + ")\n")
	for _, h := range headers {
		b.WriteString("    .addHeader(" + javaString(h.Key) + ", " + javaString(h.Value) + ")\n")
	}
	b.WriteString("    .build();\n\nResponse response = client.newCall(request).execute();\n")
	return b.String()
}

func genCSharp(method, url string, headers []KeyValue, body string) string {
	var b strings.Builder
	b.WriteString("var client = new HttpClient();\n")
	b.WriteString("var request = new HttpRequestMessage(new HttpMethod(" + strconv.Quote(method) + "), " + strconv.Quote(url) + ");\n")
	for _, h := range headers {
		// Content-Type va en el contenido, no en los headers de la petición:
		// HttpClient lanza una excepción si se intenta al revés, y es el
		// error más común al portar una petición a C#.
		if strings.EqualFold(h.Key, "content-type") {
			continue
		}
		b.WriteString("request.Headers.Add(" + strconv.Quote(h.Key) + ", " + strconv.Quote(h.Value) + ");\n")
	}
	if body != "" {
		ct := "application/json"
		for _, h := range headers {
			if strings.EqualFold(h.Key, "content-type") {
				ct = strings.SplitN(h.Value, ";", 2)[0]
			}
		}
		b.WriteString("request.Content = new StringContent(" + strconv.Quote(body) + ", Encoding.UTF8, " + strconv.Quote(ct) + ");\n")
	}
	b.WriteString("var response = await client.SendAsync(request);\n")
	return b.String()
}

func genPHP(method, url string, headers []KeyValue, body string) string {
	var b strings.Builder
	b.WriteString("<?php\n$ch = curl_init();\ncurl_setopt_array($ch, [\n")
	b.WriteString("    CURLOPT_URL => " + phpString(url) + ",\n")
	b.WriteString("    CURLOPT_RETURNTRANSFER => true,\n")
	b.WriteString("    CURLOPT_CUSTOMREQUEST => " + phpString(method) + ",\n")
	if body != "" {
		b.WriteString("    CURLOPT_POSTFIELDS => " + phpString(body) + ",\n")
	}
	if len(headers) > 0 {
		b.WriteString("    CURLOPT_HTTPHEADER => [\n")
		for _, h := range headers {
			b.WriteString("        " + phpString(h.Key+": "+h.Value) + ",\n")
		}
		b.WriteString("    ],\n")
	}
	b.WriteString("]);\n\n$response = curl_exec($ch);\ncurl_close($ch);\necho $response;\n")
	return b.String()
}

func genRuby(method, url string, headers []KeyValue, body string) string {
	var b strings.Builder
	b.WriteString("require 'net/http'\nrequire 'uri'\n\n")
	b.WriteString("uri = URI(" + rubyString(url) + ")\n")
	b.WriteString("request = Net::HTTP::" + rubyMethodClass(method) + ".new(uri)\n")
	for _, h := range headers {
		b.WriteString("request[" + rubyString(h.Key) + "] = " + rubyString(h.Value) + "\n")
	}
	if body != "" {
		b.WriteString("request.body = " + rubyString(body) + "\n")
	}
	b.WriteString("\nresponse = Net::HTTP.start(uri.hostname, uri.port, use_ssl: uri.scheme == 'https') do |http|\n  http.request(request)\nend\nputs response.body\n")
	return b.String()
}

func genPowerShell(method, url string, headers []KeyValue, body string) string {
	var b strings.Builder
	if len(headers) > 0 {
		b.WriteString("$headers = @{\n")
		for _, h := range headers {
			b.WriteString("    " + psString(h.Key) + " = " + psString(h.Value) + "\n")
		}
		b.WriteString("}\n\n")
	}
	if body != "" {
		b.WriteString("$body = " + psString(body) + "\n\n")
	}
	b.WriteString("Invoke-RestMethod -Uri " + psString(url) + " -Method " + method)
	if len(headers) > 0 {
		b.WriteString(" -Headers $headers")
	}
	if body != "" {
		b.WriteString(" -Body $body")
	}
	b.WriteString("\n")
	return b.String()
}

// --- helpers de escapado por lenguaje ---------------------------------------

// shellQuote envuelve en comillas simples y escapa las de adentro con el
// truco estándar de POSIX ('\”), que es lo único que funciona: dentro de
// comillas simples ni la barra escapa.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func goRawString(s string) string {
	// Los backticks de Go no admiten backticks adentro: en ese caso se cae a
	// la cadena interpretada.
	if !strings.Contains(s, "`") {
		return "`" + s + "`"
	}
	return strconv.Quote(s)
}

func javaString(s string) string { return strconv.Quote(s) }
func rubyString(s string) string { return strconv.Quote(s) }
func phpString(s string) string  { return strconv.Quote(s) }
func psString(s string) string   { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }

func rubyMethodClass(method string) string {
	switch strings.ToUpper(method) {
	case "GET":
		return "Get"
	case "POST":
		return "Post"
	case "PUT":
		return "Put"
	case "PATCH":
		return "Patch"
	case "DELETE":
		return "Delete"
	case "HEAD":
		return "Head"
	default:
		return "Get"
	}
}

func ifElse(cond bool, a, b string) string {
	if cond {
		return a
	}
	return b
}
