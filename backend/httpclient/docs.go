package httpclient

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// Documentación de una colección como Markdown, para publicarla en el módulo
// de notas del vault (fase 7 de .claude/specs/http-client.md).
//
// **Por qué una nota y no un panel más.** Una colección de peticiones es
// conocimiento de trabajo: qué endpoints tiene un sistema, qué manda cada uno y
// cuál es el que hay que llamar antes. Ese conocimiento sirve buscado desde el
// buscador de notas, enlazado desde un runbook y consultado por el agente —
// cosas que ya existen en el módulo de notas y que un panel dentro del cliente
// HTTP tendría que reimplementar peor.
//
// **Qué NO sale acá.** Ningún valor de credencial: ni contraseñas, ni tokens,
// ni claves de firma, ni el `client_secret`. De la autenticación se documenta
// su FORMA —qué tipo es, en qué header viaja, con qué usuario, contra qué URL
// de token— porque eso es lo que alguien necesita para entender la colección, y
// lo otro es lo que no puede quedar escrito en una nota que el agente puede
// leer. Los `{{marcadores}}` se dejan sin resolver a propósito: documentan la
// forma de la petición, y resolverlos incrustaría el valor del entorno activo.

// DocRequest es una petición ya lista para documentar: la capa de arriba
// resuelve la herencia y la ruta de carpetas, acá solo se escribe.
type DocRequest struct {
	Name   string
	Method string
	URL    string
	// Folder es la ruta de carpetas hasta la petición ("Auth / Tokens"), o
	// vacío si cuelga de la raíz.
	Folder string
	// Docs es lo que escribió el usuario en la pestaña de documentación. Se
	// copia tal cual: es Markdown, y si trae `[[enlaces]]` pasan a ser aristas
	// reales del grafo de notas al publicarse.
	Docs     string
	Params   []KeyValue
	PathVars []KeyValue
	Headers  []KeyValue
	Body     Body
	Auth     Auth
	// AuthFrom dice de dónde salió la autenticación efectiva ("de la
	// colección", "propia"), que es la mitad de la respuesta cuando alguien
	// pregunta por qué una petición manda un token y la de al lado no.
	AuthFrom string
}

// DocCollection es la colección entera con lo que hace falta para documentarla.
type DocCollection struct {
	Name        string
	Description string
	Variables   []Variable
	Auth        Auth
	Requests    []DocRequest
}

// DocTitle es el título de la nota de una colección. Único por colección y
// estable entre regeneraciones: es lo que se escribe en un `[[enlace]]` desde
// otra nota, y si cambiara al regenerar rompería esos enlaces.
func DocTitle(collectionName string) string {
	name := strings.TrimSpace(collectionName)
	if name == "" {
		name = "Sin nombre"
	}
	return "API · " + name
}

// BuildDocs escribe la nota entera.
func BuildDocs(c DocCollection) string {
	var b strings.Builder

	fmt.Fprintf(&b, "# %s\n\n", DocTitle(c.Name))
	if d := strings.TrimSpace(c.Description); d != "" {
		b.WriteString(d + "\n\n")
	}

	writeVariables(&b, c.Variables)
	if line := authSummary(c.Auth); line != "" {
		b.WriteString("## Autenticación de la colección\n\n" + line + "\n\n")
	}

	if len(c.Requests) == 0 {
		b.WriteString("_La colección todavía no tiene peticiones._\n")
		return b.String()
	}

	writeIndex(&b, c.Requests)

	b.WriteString("## Peticiones\n")
	for _, r := range c.Requests {
		writeRequest(&b, r)
	}
	return RedactCredentials(b.String())
}

// writeIndex arma el índice agrupado por carpeta. Con veinte peticiones, la
// lista de arriba es lo único que hace la nota navegable.
func writeIndex(b *strings.Builder, reqs []DocRequest) {
	b.WriteString("## Índice\n\n")

	// Sin carpetas no hay grupos que encabezar: un único título "Raíz" arriba
	// de la lista entera no dice nada que la lista no diga.
	grouped := false
	for _, r := range reqs {
		if r.Folder != "" {
			grouped = true
			break
		}
	}
	if !grouped {
		for _, r := range reqs {
			fmt.Fprintf(b, "- `%s` %s\n", r.Method, r.Name)
		}
		b.WriteString("\n")
		return
	}

	lastFolder := "\x00" // imposible como nombre, para que el primer grupo siempre imprima su encabezado
	for _, r := range reqs {
		if r.Folder != lastFolder {
			if lastFolder != "\x00" {
				// Renglón en blanco entre grupos: sin él, el encabezado del
				// grupo siguiente queda pegado a la última viñeta y Markdown lo
				// lee como continuación de esa viñeta en vez de como título.
				b.WriteString("\n")
			}
			lastFolder = r.Folder
			if r.Folder == "" {
				b.WriteString("**Raíz**\n\n")
			} else {
				fmt.Fprintf(b, "**%s**\n\n", r.Folder)
			}
		}
		fmt.Fprintf(b, "- `%s` %s\n", r.Method, r.Name)
	}
	b.WriteString("\n")
}

func writeRequest(b *strings.Builder, r DocRequest) {
	fmt.Fprintf(b, "\n### %s %s\n\n", r.Method, r.Name)
	if r.Folder != "" {
		fmt.Fprintf(b, "_En %s._\n\n", r.Folder)
	}
	fmt.Fprintf(b, "```http\n%s %s\n```\n\n", r.Method, r.URL)

	if d := strings.TrimSpace(r.Docs); d != "" {
		b.WriteString(d + "\n\n")
	}

	writeKeyValues(b, "Parámetros de ruta", r.PathVars)
	writeKeyValues(b, "Parámetros de consulta", r.Params)
	writeKeyValues(b, "Cabeceras", RedactHeaders(r.Headers))
	writeBody(b, r.Body)

	if line := authSummary(r.Auth); line != "" {
		from := r.AuthFrom
		if from != "" {
			from = " (" + from + ")"
		}
		fmt.Fprintf(b, "**Autenticación**%s: %s\n\n", from, line)
	}
}

// writeKeyValues imprime una tabla solo si hay filas habilitadas: una tabla con
// encabezado y ninguna fila es ruido que hay que leer para descubrir que estaba
// vacía.
func writeKeyValues(b *strings.Builder, title string, rows []KeyValue) {
	var kept []KeyValue
	for _, r := range rows {
		if r.Enabled && strings.TrimSpace(r.Key) != "" {
			kept = append(kept, r)
		}
	}
	if len(kept) == 0 {
		return
	}
	fmt.Fprintf(b, "**%s**\n\n| Nombre | Valor | Descripción |\n| --- | --- | --- |\n", title)
	for _, r := range kept {
		fmt.Fprintf(b, "| `%s` | %s | %s |\n", r.Key, cell(r.Value), cell(r.Description))
	}
	b.WriteString("\n")
}

func writeBody(b *strings.Builder, body Body) {
	switch body.Mode {
	case "", "none":
		return
	case "raw":
		if strings.TrimSpace(body.Raw) == "" {
			return
		}
		lang := body.RawLang
		if lang == "" {
			lang = "text"
		}
		fmt.Fprintf(b, "**Cuerpo** (%s)\n\n```%s\n%s\n```\n\n", lang, lang, clip(strings.TrimRight(body.Raw, "\n"), maxBodyChars))
	case "graphql":
		if q := strings.TrimSpace(body.GraphQLQuery); q != "" {
			fmt.Fprintf(b, "**Consulta GraphQL**\n\n```graphql\n%s\n```\n\n", clip(q, maxBodyChars))
		}
		if v := strings.TrimSpace(body.GraphQLVariables); v != "" {
			fmt.Fprintf(b, "**Variables GraphQL**\n\n```json\n%s\n```\n\n", clip(v, maxBodyChars))
		}
	case "urlencoded":
		writeKeyValues(b, "Cuerpo (formulario)", body.URLEncoded)
	case "formdata":
		var rows []KeyValue
		for _, f := range body.FormData {
			if !f.Enabled || strings.TrimSpace(f.Key) == "" {
				continue
			}
			value := f.Value
			if f.Type == "file" {
				// La ruta del archivo es de la máquina de quien armó la
				// petición: no documenta nada y sí filtra el nombre de usuario
				// del sistema.
				value = "«archivo»"
			}
			rows = append(rows, KeyValue{Key: f.Key, Value: value, Description: f.Description, Enabled: true})
		}
		writeKeyValues(b, "Cuerpo (multipart)", rows)
	case "binary":
		b.WriteString("**Cuerpo**: un archivo binario.\n\n")
	}
}

// writeVariables documenta el contrato de la colección: qué marcadores hay que
// tener definidos para poder usarla. Los valores secretos no se escriben —
// tener el nombre es lo que hace falta para configurarla.
func writeVariables(b *strings.Builder, vars []Variable) {
	var kept []Variable
	for _, v := range vars {
		if strings.TrimSpace(v.Key) != "" {
			kept = append(kept, v)
		}
	}
	if len(kept) == 0 {
		return
	}
	sort.SliceStable(kept, func(i, j int) bool { return kept[i].Key < kept[j].Key })

	b.WriteString("## Variables\n\n| Variable | Valor |\n| --- | --- |\n")
	for _, v := range kept {
		value := cell(v.Value)
		switch {
		case v.Secret:
			value = "_secreta_"
		case !v.Enabled:
			value = value + " _(deshabilitada)_"
		case strings.TrimSpace(v.Value) == "":
			value = "_sin valor_"
		}
		fmt.Fprintf(b, "| `{{%s}}` | %s |\n", v.Key, value)
	}
	b.WriteString("\n")
}

// authSummary describe la autenticación sin su credencial. Devuelve "" cuando
// no hay nada que decir, para que quien llama no imprima un encabezado vacío.
func authSummary(a Auth) string {
	switch a.Type {
	case "", "none", "inherit":
		return ""
	case "basic":
		if a.Username != "" {
			return fmt.Sprintf("Basic, con el usuario `%s`.", a.Username)
		}
		return "Basic."
	case "digest":
		if a.Username != "" {
			return fmt.Sprintf("Digest (RFC 7616), con el usuario `%s`.", a.Username)
		}
		return "Digest (RFC 7616)."
	case "bearer":
		return "Bearer: el token viaja en `Authorization: Bearer …`."
	case "apikey":
		where := "la cabecera"
		if a.In == "query" {
			where = "la consulta"
		}
		if a.Key != "" {
			return fmt.Sprintf("Clave de API en %s `%s`.", where, a.Key)
		}
		return fmt.Sprintf("Clave de API en %s.", where)
	case "jwt":
		alg := a.Algorithm
		if alg == "" {
			alg = "HS256"
		}
		return fmt.Sprintf("JWT firmado con %s, enviado en `%s`.", alg, jwtDestination(a))
	case "aws":
		parts := []string{"Firma AWS Signature v4"}
		if a.Service != "" {
			parts = append(parts, "servicio `"+a.Service+"`")
		}
		if a.Region != "" {
			parts = append(parts, "región `"+a.Region+"`")
		}
		return strings.Join(parts, ", ") + "."
	case "oauth2":
		grant := a.GrantType
		if grant == "" {
			grant = "client_credentials"
		}
		out := fmt.Sprintf("OAuth 2.0, flujo `%s`", grant)
		if a.AccessTokenURL != "" {
			out += fmt.Sprintf(", token desde `%s`", a.AccessTokenURL)
		}
		if a.Scope != "" {
			out += fmt.Sprintf(", ámbito `%s`", a.Scope)
		}
		return out + "."
	default:
		// Un tipo que esta versión no ejecuta pero que el import preservó: se
		// nombra igual, porque saber que la colección usa algo que la
		// aplicación no firma es justamente lo que hay que documentar.
		return fmt.Sprintf("`%s` (esta versión no la firma; se conserva tal como vino).", a.Type)
	}
}

func jwtDestination(a Auth) string {
	if a.AddTokenTo == "query" {
		name := a.QueryParamName
		if name == "" {
			name = "token"
		}
		return "?" + name + "="
	}
	prefix := a.HeaderPrefix
	if prefix == "" {
		prefix = "Bearer"
	}
	return "Authorization: " + prefix + " …"
}

// Topes de tamaño. Existen por lo que trae una colección capturada del
// navegador: Postman le pone a cada cabecera una descripción larga de manual
// (qué es `Accept-Encoding`, qué es `Sec-Fetch-Mode`), y sumadas convierten una
// nota de veintitrés peticiones en cien páginas de las cuales el 80% es
// relleno. El texto completo sigue estando en la colección; la documentación es
// un resumen navegable, y uno de doscientas mil letras no lo es.
const (
	maxCellChars = 300
	maxBodyChars = 4000
)

// clip recorta por RUNAS y no por bytes: cortar a la mitad un carácter acentuado
// deja basura en el documento.
func clip(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return strings.TrimSpace(string(r[:max])) + " … (recortado)"
}

// cell prepara un texto para una celda de tabla Markdown: sin saltos de línea
// (romperían la tabla) y con las barras escapadas (cortarían la celda). Una
// descripción larga de Postman con saltos adentro es el caso normal, no el raro.
func cell(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	s = clip(s, maxCellChars)
	s = strings.ReplaceAll(s, "\\", "\\\\")
	s = strings.ReplaceAll(s, "|", "\\|")
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\n", "<br>")
	return s
}

// --- Tapado de credenciales ---------------------------------------------------
//
// La documentación describe QUÉ cabecera hace falta, no su valor. La diferencia
// no es teórica: una colección capturada del navegador llega con la cookie de
// sesión y el token de acceso adentro —tanto en la tabla de cabeceras como
// dentro del `Generated from cURL:` que Postman escribe como descripción—, y la
// nota que se publica la puede leer el agente. Ver el enmascarado de variables
// secretas en vars.go: esto cubre el otro caso, el del secreto que nunca se
// declaró como variable.

// sensitiveHeaders son nombres cuyo valor es siempre una credencial. Incluye
// `client` y `uid` porque son las cabeceras de devise-token-auth, que es lo que
// usan las APIs de Rails con las que este cliente se usa a diario.
var sensitiveHeaders = map[string]bool{
	"authorization": true, "proxy-authorization": true,
	"cookie": true, "set-cookie": true,
	"x-api-key": true, "api-key": true, "apikey": true,
	"access-token": true, "refresh-token": true, "auth-token": true,
	"x-auth-token": true, "x-access-token": true, "token": true,
	"client": true, "uid": true,
	"x-csrf-token": true, "x-xsrf-token": true, "private-token": true,
	"x-amz-security-token": true,
}

const hidden = "«oculto»"

// RedactHeaders devuelve las cabeceras con el valor tapado donde corresponde.
// La fila se conserva: saber que la petición necesita `Authorization` es
// justamente lo que se está documentando.
func RedactHeaders(rows []KeyValue) []KeyValue {
	out := make([]KeyValue, len(rows))
	for i, r := range rows {
		if sensitiveHeaders[strings.ToLower(strings.TrimSpace(r.Key))] {
			r.Value = hidden
		}
		out[i] = r
	}
	return out
}

var (
	// Una cabecera escrita como texto: dentro de un `-H '…'` de cURL, de un
	// bloque ```http o de una descripción pegada a mano.
	headerLinePattern = regexp.MustCompile("(?i)^(\\s*(?:-H\\s+)?\\$?['\"`]?)([A-Za-z-]+)(\\s*:\\s*)([^'\"`\\r\\n]*)")
	// Banderas de cURL cuyo VALOR entero es una credencial: la cookie (`-b`)
	// y el usuario:contraseña de Basic (`-u`). No tienen nombre de cabecera
	// que buscar, así que van por su cuenta.
	credentialFlagPattern = regexp.MustCompile("(?i)^(\\s*(?:-b|--cookie|-u|--user)\\s+\\$?['\"`]?)")
	// Un campo de credencial dentro de un JSON.
	jsonSecretPattern = regexp.MustCompile(`(?i)("(?:[a-z_-]*(?:password|passwd|secret|token|api[_-]?key|signature|credential)[a-z_-]*)"\s*:\s*)"[^"]*"`)
	// Una credencial en la query de una URL.
	querySecretPattern = regexp.MustCompile("(?i)([?&](?:[a-z_-]*(?:password|secret|token|api[_-]?key|signature|access[_-]?key)[a-z_-]*)=)[^&\\s'\"`]*")
)

// RedactCredentials pasa sobre el texto entero como último paso.
//
// Exportada porque la documentación no es su único destino: lo que se le manda
// al agente pasa por el mismo filtro, y por la misma razón — sale de la
// máquina.
//
// Al final y no campo por campo: el texto libre que escribe el usuario, la
// descripción que llegó del import y el cuerpo de la petición son tres caminos
// distintos hasta la misma nota, y una precaución repartida en tres lugares es
// una precaución con tres formas de olvidarse.
//
// Va línea por línea y con estado porque el caso real lo pide: un `cookie:`
// copiado del navegador trae saltos de línea ADENTRO del valor, así que tapar
// solo la línea donde aparece el nombre de la cabecera deja el resto de la
// cookie escrito en las líneas siguientes. Lo comprobamos con la colección real
// del usuario, donde la sesión completa sobrevivía en trece líneas.
func RedactCredentials(md string) string {
	lines := strings.Split(md, "\n")
	out := make([]string, 0, len(lines))

	// Comilla que cierra el valor que se está tragando, o 0 si no hay ninguno
	// abierto. El contador es un tope de seguridad: si por lo que sea la
	// comilla nunca cierra, se deja de tragar en vez de comerse el documento.
	var closing byte
	swallowed := 0

	for _, line := range lines {
		if closing != 0 {
			swallowed++
			if i := unescapedQuote(line, 0, closing); i >= 0 {
				out = append(out, line[i:])
				closing = 0
			} else if swallowed > 50 || strings.HasPrefix(line, "#") || strings.HasPrefix(line, "```") {
				out = append(out, line)
				closing = 0
			}
			continue
		}

		if m := credentialFlagPattern.FindStringSubmatch(line); m != nil {
			prefix := m[1]
			rest := ""
			if q := lastByte(prefix); q == '\'' || q == '"' || q == '`' {
				if i := unescapedQuote(line, len(prefix), q); i >= 0 {
					rest = line[i:]
				} else {
					closing, swallowed = q, 0
				}
			}
			out = append(out, prefix+hidden+rest)
			continue
		}

		m := headerLinePattern.FindStringSubmatch(line)
		if m == nil || !sensitiveHeaders[strings.ToLower(m[2])] {
			out = append(out, line)
			continue
		}

		prefix, rest := m[1], line[len(m[0]):]
		// El prefijo puede ser vacío (`token: algo` al principio de renglón):
		// mirar su último byte sin comprobarlo sería un pánico.
		if q := lastByte(prefix); q == '\'' || q == '"' || q == '`' {
			if i := unescapedQuote(line, len(prefix)+len(m[2])+len(m[3]), q); i >= 0 {
				rest = line[i:]
			} else {
				// Valor entrecomillado que no cierra en esta línea: sigue abajo.
				closing, swallowed, rest = q, 0, ""
			}
		}
		out = append(out, prefix+m[2]+m[3]+hidden+rest)
	}

	md = strings.Join(out, "\n")
	md = jsonSecretPattern.ReplaceAllString(md, `${1}"`+hidden+`"`)
	md = querySecretPattern.ReplaceAllString(md, "${1}"+hidden)
	return md
}

// unescapedQuote busca desde `from` la comilla que de verdad cierra el valor,
// salteando las escapadas.
//
// Sin esto, un `$'Cookie: …\\'self\\'…'` —la forma en que bash escribe una
// cookie con apóstrofos adentro, y la que trae la colección real del usuario—
// se corta en el primer `\\'` y deja la mitad de la sesión escrita a la vista.
func unescapedQuote(s string, from int, q byte) int {
	for i := from; i < len(s); i++ {
		if s[i] != q {
			continue
		}
		// Cuenta de barras invertidas: un número par significa que la comilla
		// no está escapada (`\\\\'` es una barra y una comilla real).
		back := 0
		for j := i - 1; j >= 0 && s[j] == '\\'; j-- {
			back++
		}
		if back%2 == 0 {
			return i
		}
	}
	return -1
}

func lastByte(s string) byte {
	if s == "" {
		return 0
	}
	return s[len(s)-1]
}
