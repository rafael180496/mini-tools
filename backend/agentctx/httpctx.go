package agentctx

import (
	"fmt"
	"strings"
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
	fmt.Fprintf(b, "## Petición\n\n```http\n%s %s\n", strings.ToUpper(x.Method), x.URL)
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
		fmt.Fprintf(b, "Cuerpo enviado:\n\n```%s\n%s\n```\n\n", lang, x.Body)
	}
	if t := x.AuthType; t != "" && t != "none" && t != "inherit" {
		fmt.Fprintf(b, "Autenticación: `%s` (el valor de la credencial no se incluye).\n\n", t)
	}
}

func (x HTTPExchange) writeResponse(b *strings.Builder) {
	if x.Status == 0 && x.Error == "" {
		b.WriteString("## Respuesta\n\nTodavía no se mandó.\n\n")
		return
	}
	if x.Status == 0 {
		fmt.Fprintf(b, "## Resultado\n\nNo hubo respuesta. El error del cliente fue:\n\n```\n%s\n```\n\n", x.Error)
		return
	}

	fmt.Fprintf(b, "## Respuesta\n\n`%d %s` · %d ms · %d bytes\n\n", x.Status, x.StatusText, x.DurationMs, x.SizeBytes)
	if strings.TrimSpace(x.RespHeaders) != "" {
		fmt.Fprintf(b, "Cabeceras:\n\n```http\n%s\n```\n\n", strings.TrimRight(x.RespHeaders, "\n"))
	}
	if strings.TrimSpace(x.RespBody) != "" {
		lang := x.RespLang
		if lang == "" {
			lang = "text"
		}
		fmt.Fprintf(b, "Cuerpo recibido:\n\n```%s\n%s\n```\n\n", lang, x.RespBody)
		if x.Truncated {
			b.WriteString("_El cuerpo está cortado: lo de arriba es el principio, no la respuesta entera._\n\n")
		}
	}
}

// httpSecrecyNote se repite en cada prompt a propósito. Sin él, un agente que
// ve `Authorization: «oculto»` puede concluir que la petición sale sin
// autenticar y diagnosticar el problema equivocado.
const httpSecrecyNote = "Los valores de credenciales (`Authorization`, `Cookie`, tokens, claves de API) están " +
	"tapados como `«oculto»` antes de llegarte, y los `{{marcadores}}` van sin resolver. " +
	"Están presentes en la petición real: no concluyas que faltan.\n\n"

// HTTPExplainPrompt: "explicame esta respuesta".
func HTTPExplainPrompt(x HTTPExchange) string {
	var b strings.Builder
	b.WriteString("Explicá qué contestó esta API y qué significa para quien la está probando.\n\n")
	x.writeRequest(&b)
	x.writeResponse(&b)
	b.WriteString(httpSecrecyNote)
	b.WriteString(`## Qué contestar

1. Qué dice la respuesta, en una o dos frases.
2. Qué significa el código de estado EN ESTE caso concreto, no en general.
3. Si el cuerpo trae datos, qué campos son los importantes y qué representan.
4. Si algo llama la atención —un campo vacío que debería tener valor, una
   cabecera de caché o de paginación que cambia cómo hay que usar el endpoint,
   un tiempo de respuesta alto—, decilo.

Sé breve. No repitas el cuerpo entero: quien pregunta ya lo tiene en pantalla.
`)
	return b.String()
}

// HTTPDiagnosePrompt: "esto falló, ¿por qué?".
//
// Va con los settings del cliente porque la mitad de los fallos de transporte
// se explican ahí: un timeout corto, la verificación de TLS activada contra un
// certificado interno, las redirecciones desactivadas.
func HTTPDiagnosePrompt(x HTTPExchange) string {
	var b strings.Builder
	b.WriteString("Esta petición HTTP falló. Explicá por qué y cómo arreglarla.\n\n")
	x.writeRequest(&b)
	if strings.TrimSpace(x.Settings) != "" {
		fmt.Fprintf(&b, "## Configuración del cliente\n\n%s\n\n", x.Settings)
	}
	x.writeResponse(&b)
	b.WriteString(httpSecrecyNote)
	b.WriteString(`## Qué contestar

1. Qué falló, en una frase.
2. La causa más probable. Si hay varias, ordenalas por probabilidad.
3. Qué hacer, concreto: qué cambiar en la petición, en la configuración del
   cliente o del lado del servidor.

Distinguí bien de qué lado está el problema: no es lo mismo un DNS que no
resuelve, un certificado que no valida, un timeout, un 401 por credenciales, un
403 por permisos, un 404 por la ruta, un 415 por el Content-Type o un 500 del
servidor. Si el error es de transporte y la configuración de arriba lo explica,
decilo derecho.
`)
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
	b.WriteString("Escribí una petición HTTP a partir de lo que se pide abajo.\n\n")

	if strings.TrimSpace(x.URL) != "" {
		b.WriteString("Hay una petición en pantalla que hay que MODIFICAR, no escribir una desde cero:\n\n")
		x.writeRequest(&b)
	}

	b.WriteString("## Lo que se pide\n\n")
	b.WriteString(strings.TrimSpace(request))
	b.WriteString("\n\n")

	if len(variables) > 0 {
		b.WriteString("## Variables disponibles\n\nUsá estos marcadores en vez de escribir valores fijos donde corresponda:\n\n")
		for _, v := range variables {
			b.WriteString("- `{{" + v + "}}`\n")
		}
		b.WriteString("\n")
	}

	b.WriteString(`## Qué contestar

Un solo comando ` + "`curl`" + ` dentro de un bloque de código, y arriba una o dos frases
diciendo qué hace. Reglas del comando:

- Una opción por línea, con ` + "`\\`" + ` al final, como el «Copiar como cURL» del navegador.
- Method con ` + "`-X`" + `, cabeceras con ` + "`-H`" + `, cuerpo con ` + "`--data-raw`" + `.
- Si hace falta una credencial, escribila como ` + "`{{marcador}}`" + `, nunca inventes un token.
- Nada de comentarios adentro del bloque: se importa tal cual.
`)
	return b.String()
}

// HTTPDocsPrompt: redactar la documentación de una petición.
//
// El resultado va a la pestaña Docs, que se publica como nota del vault (fase
// 7): por eso se pide Markdown y se avisa que los `[[enlaces]]` valen.
func HTTPDocsPrompt(x HTTPExchange, currentDocs string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Redactá la documentación de esta petición HTTP%s.\n\n", nameSuffix(x.Name))
	x.writeRequest(&b)
	x.writeResponse(&b)

	if strings.TrimSpace(currentDocs) != "" {
		b.WriteString("## Documentación actual\n\nHay que MEJORARLA conservando lo que ya dice:\n\n")
		b.WriteString(currentDocs)
		b.WriteString("\n\n")
	}

	b.WriteString(httpSecrecyNote)
	b.WriteString(`## Qué contestar

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
`)
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
	b.WriteString("Escribí los tests de esta petición HTTP en el formato de Postman (`pm.test`).\n\n")
	x.writeRequest(&b)
	x.writeResponse(&b)
	b.WriteString(httpSecrecyNote)
	b.WriteString(`## Qué contestar

Solo el JavaScript, en un bloque de código ` + "`javascript`" + `. Sin explicación alrededor.

- Usá ` + "`pm.test`" + `, ` + "`pm.response`" + ` y ` + "`pm.expect`" + `: es el dialecto de Postman.
- Cubrí el código de estado, el tipo de contenido y la forma del cuerpo que se ve
  arriba (campos presentes y su tipo), no valores concretos de una respuesta
  puntual — un test que exige el id 42 falla mañana.
- Si la respuesta trae algo que sirva para la petición siguiente (un token, un
  id), guardalo con ` + "`pm.environment.set`" + `.
- Nada de esperas ni de peticiones adentro del test.
`)
	return b.String()
}

func nameSuffix(name string) string {
	if strings.TrimSpace(name) == "" {
		return ""
	}
	return fmt.Sprintf(" («%s»)", name)
}
