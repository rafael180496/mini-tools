package main

import (
	"fmt"
	"strings"

	"mini-tools/backend/agentctx"
	"mini-tools/backend/httpclient"
)

// IA sobre peticiones HTTP (fase 8 de .claude/specs/http-client.md).
//
// Cinco acciones, todas de un solo turno con `AgentAsk`: explicar una
// respuesta, diagnosticar un fallo, generar una petición desde una descripción,
// redactar la documentación y escribir los tests. Ninguna manda nada ni escribe
// nada por su cuenta — devuelven texto, y aplicarlo es un clic del usuario.
// Mismo trato que la IA de bases de datos: **el agente propone**.
//
// **Qué NO cruza, y dónde se garantiza.** El armado del contexto vive acá y no
// en agentctx a propósito: es el único lugar con acceso al vault y a las
// variables, así que es el único que puede tapar lo que hay que tapar. Tres
// filtros, en este orden:
//
//  1. Los `{{marcadores}}` se dejan **sin resolver**. No es solo higiene: es lo
//     que hace que el prompt describa la forma de la petición y no el valor del
//     entorno de hoy.
//  2. Las cabeceras de credencial se tapan por nombre (`RedactHeaders`).
//  3. El texto entero pasa por `MaskSecrets` (valores de variables marcadas
//     secretas) y por `RedactCredentials` (una credencial escrita a mano dentro
//     de una URL, de un cuerpo o de un `-H` pegado).
//
// De la autenticación viaja el TIPO y nada más. Un agente corre en un
// subproceso que habla con un servicio remoto: el token de producción del
// usuario no tiene por qué llegar hasta ahí para que le expliquen un 401.

// maxAgentBody acota cuerpos de petición y de respuesta. Una respuesta de dos
// megabytes no ayuda al agente: le llena la ventana de contexto y desplaza la
// pregunta. Con los primeros miles de caracteres alcanza para ver la forma del
// JSON, que es lo que se está preguntando.
const maxAgentBody = 6000

// HTTPGenerated es una petición propuesta por el agente.
type HTTPGenerated struct {
	// Answer es la explicación en Markdown, que se muestra al lado. No se
	// descarta: aplicar una petición sin saber por qué quedó así obliga a
	// leerla entera para entender qué cambió.
	Answer string `json:"answer"`
	// Request es lo que se aplicaría al editor, ya parseado del cURL que
	// devolvió el agente. Nil si no se pudo interpretar.
	Request *httpclient.Request `json:"request,omitempty"`
	// Curl es el comando tal cual lo escribió el agente, para poder mostrarlo
	// aunque no se haya podido parsear.
	Curl string `json:"curl,omitempty"`
}

// AgentExplainHTTP explica una respuesta ya recibida.
func (a *App) AgentExplainHTTP(itemID string, req httpclient.Request, resp httpclient.Response, errText string) (string, error) {
	x, err := a.exchange(itemID, req, resp, errText)
	if err != nil {
		return "", err
	}
	if x.Status == 0 && x.Error == "" {
		return "", fmt.Errorf("app: todavía no hay una respuesta que explicar — mandá la petición primero")
	}
	return a.AgentAsk(agentctx.HTTPExplainPrompt(x), "http", itemID)
}

// AgentDiagnoseHTTP explica por qué falló una petición.
func (a *App) AgentDiagnoseHTTP(itemID string, req httpclient.Request, resp httpclient.Response, errText string) (string, error) {
	x, err := a.exchange(itemID, req, resp, errText)
	if err != nil {
		return "", err
	}
	if x.Status == 0 && x.Error == "" {
		return "", fmt.Errorf("app: no hay ningún fallo que diagnosticar todavía")
	}
	return a.AgentAsk(agentctx.HTTPDiagnosePrompt(x), "http", itemID)
}

// AgentGenerateHTTP escribe una petición a partir de una descripción en
// lenguaje natural o de un cURL pegado con instrucciones.
//
// La respuesta se pide como un comando cURL y se importa con el mismo parser
// que el botón «Pegar un comando cURL»: un formato que el usuario puede leer y
// verificar antes de aplicarlo, y un parser menos que mantener.
func (a *App) AgentGenerateHTTP(itemID, description string, current httpclient.Request) (*HTTPGenerated, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	if strings.TrimSpace(description) == "" {
		return nil, fmt.Errorf("app: el pedido está vacío")
	}
	x, err := a.exchange(itemID, current, httpclient.Response{}, "")
	if err != nil {
		return nil, err
	}

	answer, err := a.AgentAsk(agentctx.HTTPGeneratePrompt(description, x, a.variableNames(itemID)), "http", itemID)
	if err != nil {
		return nil, err
	}

	out := &HTTPGenerated{Answer: answer, Curl: agentctx.ExtractCode(answer)}
	if strings.TrimSpace(out.Curl) != "" {
		// Un cURL que no se puede interpretar NO es un error de la acción: la
		// explicación y el comando siguen sirviendo, y el usuario puede
		// copiarlo a mano. Se devuelve sin Request y la UI lo dice.
		if parsed, perr := httpclient.ParseCurl(out.Curl); perr == nil {
			out.Request = &parsed
		}
	}
	return out, nil
}

// AgentDraftHTTPDocs redacta la documentación de una petición. Lo que devuelve
// va a la pestaña Docs, que es lo que después se publica como nota del vault.
func (a *App) AgentDraftHTTPDocs(itemID string, req httpclient.Request, resp httpclient.Response, currentDocs string) (string, error) {
	x, err := a.exchange(itemID, req, resp, "")
	if err != nil {
		return "", err
	}
	return a.AgentAsk(agentctx.HTTPDocsPrompt(x, currentDocs), "http", itemID)
}

// AgentDraftHTTPTests escribe los tests de una petición, en el formato de
// Postman.
//
// **Esta aplicación no los ejecuta**: se guardan y se exportan con la
// colección, y quien los corre es Postman o newman. Se decidió así al descartar
// incorporar un motor de JavaScript (+19,8 MB contra un techo de 80). Pedirlos
// en un dialecto que acá nadie corre sería una promesa falsa; pedirlos en el de
// Postman es lo que de verdad sirve.
func (a *App) AgentDraftHTTPTests(itemID string, req httpclient.Request, resp httpclient.Response) (string, error) {
	x, err := a.exchange(itemID, req, resp, "")
	if err != nil {
		return "", err
	}
	answer, err := a.AgentAsk(agentctx.HTTPTestsPrompt(x), "http", itemID)
	if err != nil {
		return "", err
	}
	// Se devuelve el código pelado: va derecho al campo del script, no a un
	// panel de lectura.
	if code := agentctx.ExtractCode(answer); strings.TrimSpace(code) != "" {
		return code, nil
	}
	return answer, nil
}

// --- Armado del contexto ------------------------------------------------------

// exchange arma la petición (y su respuesta, si la hubo) ya redactada.
func (a *App) exchange(itemID string, req httpclient.Request, resp httpclient.Response, errText string) (agentctx.HTTPExchange, error) {
	if err := a.requireUnlocked(); err != nil {
		return agentctx.HTTPExchange{}, err
	}

	collectionID := a.collectionOf(itemID)
	scopes := a.varScopes(collectionID)

	x := agentctx.HTTPExchange{
		Name:     a.itemName(itemID),
		Method:   req.Method,
		URL:      req.URL,
		Headers:  headerLines(httpclient.RedactHeaders(req.Headers)),
		BodyLang: req.Body.RawLang,
		Settings: describeSettings(req.Settings),
		Error:    errText,
	}
	x.Body = bodyText(req.Body)

	// El tipo de autenticación efectiva, sin su credencial: es lo que hace
	// falta para entender un 401 y lo único que se puede decir sin filtrar.
	auth, _ := a.authFor(itemID, req.Auth, nil)
	x.AuthType = auth.Type

	// Status 0 es "no hubo respuesta": ningún servidor contesta con 0, así que
	// alcanza para distinguirlo sin un booleano aparte. Importa para el
	// contrato del binding: Wails no expresa punteros en TypeScript, así que
	// la respuesta viaja SIEMPRE como valor y su ausencia se dice con el cero.
	if resp.Status != 0 {
		x.Status = resp.Status
		x.StatusText = resp.StatusText
		x.DurationMs = resp.DurationMs
		x.SizeBytes = resp.SizeBytes
		x.RespHeaders = headerLines(httpclient.RedactHeaders(resp.Headers))
		x.RespLang = resp.Lang
		x.Truncated = resp.Truncated
		switch {
		case resp.IsBinary:
			// Mandar base64 de una imagen no le dice nada al agente y ocupa la
			// ventana entera.
			x.RespBody = fmt.Sprintf("(contenido binario, %s, %d bytes)", resp.ContentType, resp.SizeBytes)
		default:
			x.RespBody = clipText(resp.Body, maxAgentBody)
			if len(resp.Body) > maxAgentBody {
				x.Truncated = true
			}
		}
	}

	return redactExchange(x, scopes), nil
}

// redactExchange pasa por el filtro de secretos TODOS los campos de texto de
// una sola vez.
//
// Campo por campo y no en el punto donde se arma cada uno: son ocho caminos
// distintos hasta el mismo prompt, y una precaución repartida en ocho lugares
// es una precaución con ocho formas de olvidarse. Que sea el último paso es lo
// que hace que agregar un campo nuevo quede cubierto sin acordarse.
func redactExchange(x agentctx.HTTPExchange, scopes []httpclient.VarScope) agentctx.HTTPExchange {
	clean := func(s string) string {
		return httpclient.RedactCredentials(httpclient.MaskSecrets(s, scopes))
	}
	x.URL = clean(x.URL)
	x.Headers = clean(x.Headers)
	x.Body = clean(x.Body)
	x.RespHeaders = clean(x.RespHeaders)
	x.RespBody = clean(x.RespBody)
	x.Error = clean(x.Error)
	x.Settings = clean(x.Settings)
	return x
}

// headerLines escribe las cabeceras como las escribe HTTP, una por línea. Se
// saltean las deshabilitadas: no viajan, así que tampoco explican nada.
func headerLines(rows []httpclient.KeyValue) string {
	var b strings.Builder
	for _, r := range rows {
		if !r.Enabled || strings.TrimSpace(r.Key) == "" {
			continue
		}
		b.WriteString(r.Key + ": " + r.Value + "\n")
	}
	return b.String()
}

// bodyText describe el cuerpo según su modo. Para un archivo se dice que es un
// archivo: su ruta es de la máquina de quien armó la petición y no documenta
// nada.
func bodyText(body httpclient.Body) string {
	switch body.Mode {
	case "raw":
		return clipText(body.Raw, maxAgentBody)
	case "graphql":
		return clipText(strings.TrimSpace(body.GraphQLQuery+"\n\n"+body.GraphQLVariables), maxAgentBody)
	case "urlencoded":
		var b strings.Builder
		for _, kv := range body.URLEncoded {
			if kv.Enabled && kv.Key != "" {
				b.WriteString(kv.Key + "=" + kv.Value + "\n")
			}
		}
		return b.String()
	case "formdata":
		var b strings.Builder
		for _, f := range body.FormData {
			if !f.Enabled || f.Key == "" {
				continue
			}
			if f.Type == "file" {
				b.WriteString(f.Key + ": (archivo)\n")
				continue
			}
			b.WriteString(f.Key + ": " + f.Value + "\n")
		}
		return b.String()
	case "binary":
		return "(un archivo binario)"
	}
	return ""
}

// describeSettings pone en palabras lo que decide la mitad de los fallos de
// transporte.
func describeSettings(s httpclient.Settings) string {
	verify := "verifica el certificado TLS"
	if !s.VerifyTLS {
		verify = "**no** verifica el certificado TLS"
	}
	redirects := fmt.Sprintf("sigue hasta %d redirecciones", s.MaxRedirects)
	if !s.FollowRedirects {
		redirects = "**no** sigue redirecciones"
	}
	version := s.HTTPVersion
	if version == "" {
		version = "automática"
	}
	return fmt.Sprintf("Timeout de %d ms, %s, %s, versión de HTTP %s.", s.TimeoutMs, verify, redirects, version)
}

// variableNames lista los nombres de variables que el agente puede usar. Solo
// los NOMBRES: el valor de una variable de entorno es justamente lo que no
// tiene por qué salir de la máquina.
func (a *App) variableNames(itemID string) []string {
	var out []string
	seen := map[string]bool{}
	for _, scope := range a.varScopes(a.collectionOf(itemID)) {
		for _, v := range scope.Vars {
			if v.Key == "" || seen[v.Key] {
				continue
			}
			seen[v.Key] = true
			out = append(out, v.Key)
		}
	}
	return out
}

func (a *App) itemName(itemID string) string {
	if itemID == "" {
		return ""
	}
	it, err := a.vault.GetHTTPItem(itemID)
	if err != nil || it == nil {
		return ""
	}
	return it.Name
}

// clipText corta por runas, no por bytes: partir a la mitad un carácter
// acentuado deja basura en el prompt.
func clipText(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max]) + "\n… (cortado)"
}
