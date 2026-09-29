package agentctx

import (
	"fmt"
	"strings"

	"mini-tools/backend/i18n"
)

// Contexto e instrucciones para la IA del módulo de peticiones HTTP.
//
// Mismo trato que el resto de este paquete: acá solo se ARMA el texto. Quien
// llama es el que decide qué campos poner adentro, y es el que ya los pasó por
// el filtro de secretos (ver app_httpagent.go). Este archivo no tiene acceso al
// vault ni a las variables, a propósito: si el filtrado viviera acá, agregar un
// campo nuevo a la petición sería una forma silenciosa de filtrarlo.
//
// **Lo que nunca entra en un prompt**, y por qué está escrito acá aunque se
// aplique afuera: ningún valor de una variable marcada como secreta, ningún
// valor de una cabecera de credencial (`Authorization`, `Cookie`,
// `access-token`…), y de la autenticación solo su TIPO. Un agente corre en un
// subproceso que habla con un servicio remoto; el token de producción del
// usuario no tiene por qué llegar hasta ahí para que le expliquen un 401.

// HTTPExchange es una petición y —si la hubo— su respuesta, ya redactadas.
type HTTPExchange struct {
	Name   string
	Method string
	URL    string
	// Headers y Body van como texto plano listo para el prompt: quien llama ya
	// eligió qué mostrar y qué tapar.
	Headers string
	Body    string
	// BodyLang es "json", "xml"… para el bloque de código.
	BodyLang string
	// AuthType es el tipo de autenticación efectiva ("bearer", "aws"), NUNCA
	// su credencial. Vacío o "none" si no lleva.
	AuthType string
	// Settings describe timeout, redirecciones y verificación de TLS: es
	// exactamente lo que hace falta para diagnosticar un fallo de transporte.
	Settings string

	// Respuesta. Status 0 significa que la petición no llegó a contestar.
	Status      int
	StatusText  string
	DurationMs  int64
	SizeBytes   int64
	RespHeaders string
	RespBody    string
	RespLang    string
	Truncated   bool
	// Error es el fallo de transporte tal cual lo devolvió Go, cuando lo hubo.
	Error string
}

// writeRequest escribe la parte de la petición, que es común a los cinco
// pedidos.
func (x HTTPExchange) writeRequest(b *strings.Builder) {
	b.WriteString(i18n.T(i18n.Msg{ES: "## Petición", EN: "## Request"}) + "\n\n```http\n" + strings.ToUpper(x.Method) + " " + x.URL + "\n")
	if strings.TrimSpace(x.Headers) != "" {
		b.WriteString(x.Headers)
		if !strings.HasSuffix(x.Headers, "\n") {
			b.WriteString("\n")
		}
	}
	b.WriteString("```\n\n")

	if strings.TrimSpace(x.Body) != "" {
		lang := x.BodyLang
		if lang == "" {
			lang = "text"
		}
		b.WriteString(i18n.T(i18n.Msg{ES: "Cuerpo enviado:", EN: "Body sent:"}) + "\n\n```" + lang + "\n" + x.Body + "\n```\n\n")
	}
	if t := x.AuthType; t != "" && t != "none" && t != "inherit" {
		b.WriteString(i18n.T(i18n.Msg{ES: "Autenticación: `%s` (el valor de la credencial no se incluye).", EN: "Authentication: `%s` (the credential value is not included)."}, t) + "\n\n")
	}
}

func (x HTTPExchange) writeResponse(b *strings.Builder) {
	if x.Status == 0 && x.Error == "" {
		b.WriteString(i18n.T(msgResponseHeading) + "\n\n" + i18n.T(i18n.Msg{ES: "Todavía no se mandó.", EN: "It has not been sent yet."}) + "\n\n")
		return
	}
	if x.Status == 0 {
		b.WriteString(i18n.T(i18n.Msg{ES: "## Resultado\n\nNo hubo respuesta. El error del cliente fue:", EN: "## Result\n\nThere was no response. The client error was:"}) + "\n\n```\n" + x.Error + "\n```\n\n")
		return
	}

	b.WriteString(i18n.T(msgResponseHeading) + "\n\n")
	fmt.Fprintf(b, "`%d %s` · %d ms · %d bytes\n\n", x.Status, x.StatusText, x.DurationMs, x.SizeBytes)
	if strings.TrimSpace(x.RespHeaders) != "" {
		b.WriteString(i18n.T(i18n.Msg{ES: "Cabeceras:", EN: "Headers:"}) + "\n\n```http\n" + strings.TrimRight(x.RespHeaders, "\n") + "\n```\n\n")
	}
	if strings.TrimSpace(x.RespBody) != "" {
		lang := x.RespLang
		if lang == "" {
			lang = "text"
		}
		b.WriteString(i18n.T(i18n.Msg{ES: "Cuerpo recibido:", EN: "Body received:"}) + "\n\n```" + lang + "\n" + x.RespBody + "\n```\n\n")
		if x.Truncated {
			b.WriteString(i18n.T(i18n.Msg{ES: "_El cuerpo está cortado: lo de arriba es el principio, no la respuesta entera._", EN: "_The body is truncated: what is above is the beginning, not the whole response._"}) + "\n\n")
		}
	}
}

// HTTPChatContext es la petición y su respuesta como bloque de contexto para
// el chat: lo mismo que ven los cinco pedidos de una tirada —ya redactado—,
// sin la consigna de ninguno. La pregunta la escribe el usuario.
func HTTPChatContext(x HTTPExchange) string {
	var b strings.Builder
	x.writeRequest(&b)
	x.writeResponse(&b)
	b.WriteString(i18n.T(httpSecrecyNote))
	return strings.TrimSpace(b.String())
}

// httpSecrecyNote se repite en cada prompt a propósito. Sin él, un agente que
// ve `Authorization: «oculto»` puede concluir que la petición sale sin
// autenticar y diagnosticar el problema equivocado.
var httpSecrecyNote = i18n.Msg{
	ES: "Los valores de credenciales (`Authorization`, `Cookie`, tokens, claves de API) están " +
		"tapados como `«oculto»` antes de llegarte, y los `{{marcadores}}` van sin resolver. " +
		"Están presentes en la petición real: no concluyas que faltan.\n\n",
	EN: "Credential values (`Authorization`, `Cookie`, tokens, API keys) are " +
		"masked as `«hidden»` before reaching you, and the `{{placeholders}}` are left unresolved. " +
		"They are present in the real request: do not conclude that they are missing.\n\n",
}

var msgResponseHeading = i18n.Msg{ES: "## Respuesta", EN: "## Response"}

// HTTPExplainPrompt: "explicame esta respuesta".
func HTTPExplainPrompt(x HTTPExchange) string {
	var b strings.Builder
	b.WriteString(i18n.T(i18n.Msg{ES: "Explicá qué contestó esta API y qué significa para quien la está probando.", EN: "Explain what this API answered and what it means for whoever is testing it."}) + "\n\n")
	x.writeRequest(&b)
	x.writeResponse(&b)
	b.WriteString(i18n.T(httpSecrecyNote))
	b.WriteString(i18n.T(msgWhatToAnswer) + i18n.T(i18n.Msg{
		ES: `

1. Qué dice la respuesta, en una o dos frases.
2. Qué significa el código de estado EN ESTE caso concreto, no en general.
3. Si el cuerpo trae datos, qué campos son los importantes y qué representan.
4. Si algo llama la atención —un campo vacío que debería tener valor, una
   cabecera de caché o de paginación que cambia cómo hay que usar el endpoint,
   un tiempo de respuesta alto—, decilo.

Sé breve. No repitas el cuerpo entero: quien pregunta ya lo tiene en pantalla.
`,
		EN: `

1. What the response says, in one or two sentences.
2. What the status code means IN THIS specific case, not in general.
3. If the body carries data, which fields are the important ones and what they represent.
4. If something stands out —an empty field that should have a value, a
   caching or pagination header that changes how the endpoint has to be used,
   a high response time—, say so.

Be brief. Do not repeat the whole body: whoever is asking already has it on screen.
`,
	}))
	return b.String()
}

// HTTPDiagnosePrompt: "esto falló, ¿por qué?".
//
// Va con los settings del cliente porque la mitad de los fallos de transporte
// se explican ahí: un timeout corto, la verificación de TLS activada contra un
// certificado interno, las redirecciones desactivadas.
func HTTPDiagnosePrompt(x HTTPExchange) string {
	var b strings.Builder
	b.WriteString(i18n.T(i18n.Msg{ES: "Esta petición HTTP falló. Explicá por qué y cómo arreglarla.", EN: "This HTTP request failed. Explain why and how to fix it."}) + "\n\n")
	x.writeRequest(&b)
	if strings.TrimSpace(x.Settings) != "" {
		b.WriteString(i18n.T(i18n.Msg{ES: "## Configuración del cliente", EN: "## Client settings"}) + "\n\n" + x.Settings + "\n\n")
	}
	x.writeResponse(&b)
	b.WriteString(i18n.T(httpSecrecyNote))
	b.WriteString(i18n.T(msgWhatToAnswer) + i18n.T(i18n.Msg{
		ES: `

1. Qué falló, en una frase.
2. La causa más probable. Si hay varias, ordenalas por probabilidad.
3. Qué hacer, concreto: qué cambiar en la petición, en la configuración del
   cliente o del lado del servidor.

Distinguí bien de qué lado está el problema: no es lo mismo un DNS que no
resuelve, un certificado que no valida, un timeout, un 401 por credenciales, un
403 por permisos, un 404 por la ruta, un 415 por el Content-Type o un 500 del
servidor. Si el error es de transporte y la configuración de arriba lo explica,
decilo derecho.
`,
		EN: `

1. What failed, in one sentence.
2. The most likely cause. If there are several, order them by likelihood.
3. What to do, concretely: what to change in the request, in the client
   settings or on the server side.

Tell clearly on which side the problem is: a DNS name that does not
resolve, a certificate that does not validate, a timeout, a 401 for credentials, a
403 for permissions, a 404 for the path, a 415 for the Content-Type or a 500 from the
server are not the same thing. If the error is a transport one and the settings above explain it,
say so straight away.
`,
	}))
	return b.String()
}

// HTTPGeneratePrompt: escribir una petición desde una descripción.
//
// La respuesta se pide **como un comando cURL** y no como una estructura
// inventada: es un formato que todo modelo escribe bien, que el usuario puede
// leer y verificar de un vistazo, y que esta app ya sabe importar
// (httpclient.ParseCurl). Un formato propio sería otro parser más que mantener
// y una cosa más que el modelo puede equivocar.
func HTTPGeneratePrompt(request string, x HTTPExchange, variables []string) string {
	var b strings.Builder
	b.WriteString(i18n.T(i18n.Msg{ES: "Escribí una petición HTTP a partir de lo que se pide abajo.", EN: "Write an HTTP request from what is asked below."}) + "\n\n")

	if strings.TrimSpace(x.URL) != "" {
		b.WriteString(i18n.T(i18n.Msg{ES: "Hay una petición en pantalla que hay que MODIFICAR, no escribir una desde cero:", EN: "There is a request on screen that has to be MODIFIED, not written from scratch:"}) + "\n\n")
		x.writeRequest(&b)
	}

	b.WriteString(i18n.T(i18n.Msg{ES: "## Lo que se pide", EN: "## What is being asked"}) + "\n\n")
	b.WriteString(strings.TrimSpace(request))
	b.WriteString("\n\n")

	if len(variables) > 0 {
		b.WriteString(i18n.T(i18n.Msg{ES: "## Variables disponibles\n\nUsá estos marcadores en vez de escribir valores fijos donde corresponda:", EN: "## Available variables\n\nUse these placeholders instead of writing fixed values where appropriate:"}) + "\n\n")
		for _, v := range variables {
			b.WriteString("- `{{" + v + "}}`\n")
		}
		b.WriteString("\n")
	}

	b.WriteString(i18n.T(msgWhatToAnswer) + i18n.T(i18n.Msg{
		ES: `

Un solo comando ` + "`curl`" + ` dentro de un bloque de código, y arriba una o dos frases
diciendo qué hace. Reglas del comando:

- Una opción por línea, con ` + "`\\`" + ` al final, como el «Copiar como cURL» del navegador.
- Method con ` + "`-X`" + `, cabeceras con ` + "`-H`" + `, cuerpo con ` + "`--data-raw`" + `.
- Si hace falta una credencial, escribila como ` + "`{{marcador}}`" + `, nunca inventes un token.
- Nada de comentarios adentro del bloque: se importa tal cual.
`,
		EN: `

A single ` + "`curl`" + ` command inside a code block, and above it one or two sentences
saying what it does. Rules for the command:

- One option per line, with ` + "`\\`" + ` at the end, like the browser's “Copy as cURL”.
- Method with ` + "`-X`" + `, headers with ` + "`-H`" + `, body with ` + "`--data-raw`" + `.
- If a credential is needed, write it as ` + "`{{placeholder}}`" + `, never invent a token.
- No comments inside the block: it is imported as-is.
`,
	}))
	return b.String()
}

// HTTPDocsPrompt: redactar la documentación de una petición.
//
// El resultado va a la pestaña Docs, que se publica como nota del vault (fase
// 7): por eso se pide Markdown y se avisa que los `[[enlaces]]` valen.
func HTTPDocsPrompt(x HTTPExchange, currentDocs string) string {
	var b strings.Builder
	b.WriteString(i18n.T(i18n.Msg{ES: "Redactá la documentación de esta petición HTTP%s.", EN: "Write the documentation for this HTTP request%s."}, nameSuffix(x.Name)) + "\n\n")
	x.writeRequest(&b)
	x.writeResponse(&b)

	if strings.TrimSpace(currentDocs) != "" {
		b.WriteString(i18n.T(i18n.Msg{ES: "## Documentación actual\n\nHay que MEJORARLA conservando lo que ya dice:", EN: "## Current documentation\n\nIt has to be IMPROVED, keeping what it already says:"}) + "\n\n")
		b.WriteString(currentDocs)
		b.WriteString("\n\n")
	}

	b.WriteString(i18n.T(httpSecrecyNote))
	b.WriteString(i18n.T(msgWhatToAnswer) + i18n.T(i18n.Msg{
		ES: `

Solo el Markdown de la documentación, sin encabezado de título y sin envolverlo
en un bloque de código. Cubrí, en este orden y solo lo que se pueda afirmar
mirando lo de arriba:

- Para qué sirve el endpoint, en una o dos frases.
- Los parámetros y cabeceras que importan, y qué valor espera cada uno.
- Qué devuelve cuando sale bien.
- Errores previsibles y qué los provoca.

No inventes campos, códigos de error ni parámetros que no estén arriba: si algo
no se puede saber, no lo pongas. Podés enlazar otras notas del vault con
` + "`[[Título]]`" + ` si viene al caso.
`,
		EN: `

Only the Markdown of the documentation, without a title heading and without wrapping it
in a code block. Cover, in this order and only what can be asserted
by looking at the above:

- What the endpoint is for, in one or two sentences.
- The parameters and headers that matter, and what value each one expects.
- What it returns when it succeeds.
- Foreseeable errors and what causes them.

Do not invent fields, error codes or parameters that are not above: if something
cannot be known, leave it out. You can link other notes in the vault with
` + "`[[Title]]`" + ` if relevant.
`,
	}))
	return b.String()
}

// HTTPTestsPrompt: escribir los tests de la petición.
//
// **Esta app no los ejecuta** y el prompt lo dice: los scripts se guardan y se
// exportan, y quien los corre es Postman o newman con la colección exportada
// (ver la fase 5 del plan, donde se decidió no incorporar un motor de
// JavaScript). Pedirle al agente tests en un dialecto que acá nadie corre sería
// una promesa falsa; pedírselos en el de Postman es exactamente lo que sirve.
func HTTPTestsPrompt(x HTTPExchange) string {
	var b strings.Builder
	b.WriteString(i18n.T(i18n.Msg{ES: "Escribí los tests de esta petición HTTP en el formato de Postman (`pm.test`).", EN: "Write the tests for this HTTP request in Postman format (`pm.test`)."}) + "\n\n")
	x.writeRequest(&b)
	x.writeResponse(&b)
	b.WriteString(i18n.T(httpSecrecyNote))
	b.WriteString(i18n.T(msgWhatToAnswer) + i18n.T(i18n.Msg{
		ES: `

Solo el JavaScript, en un bloque de código ` + "`javascript`" + `. Sin explicación alrededor.

- Usá ` + "`pm.test`" + `, ` + "`pm.response`" + ` y ` + "`pm.expect`" + `: es el dialecto de Postman.
- Cubrí el código de estado, el tipo de contenido y la forma del cuerpo que se ve
  arriba (campos presentes y su tipo), no valores concretos de una respuesta
  puntual — un test que exige el id 42 falla mañana.
- Si la respuesta trae algo que sirva para la petición siguiente (un token, un
  id), guardalo con ` + "`pm.environment.set`" + `.
- Nada de esperas ni de peticiones adentro del test.
`,
		EN: `

Only the JavaScript, in a ` + "`javascript`" + ` code block. No explanation around it.

- Use ` + "`pm.test`" + `, ` + "`pm.response`" + ` and ` + "`pm.expect`" + `: it is Postman's dialect.
- Cover the status code, the content type and the shape of the body seen
  above (fields present and their type), not concrete values from one specific
  response — a test that demands id 42 fails tomorrow.
- If the response carries something useful for the next request (a token, an
  id), save it with ` + "`pm.environment.set`" + `.
- No waits and no requests inside the test.
`,
	}))
	return b.String()
}

func nameSuffix(name string) string {
	if strings.TrimSpace(name) == "" {
		return ""
	}
	return fmt.Sprintf(" («%s»)", name)
}
