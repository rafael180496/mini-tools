// Package httpclient es el motor del módulo de peticiones HTTP: arma, envía
// y describe una petición, sin saber nada de cómo se guarda ni de cómo se
// dibuja.
//
// # Por qué net/http pelado y ninguna dependencia
//
// Todo lo que el módulo ofrece por request —verificación TLS opcional,
// política de redirecciones con sus cuatro variantes, versión de HTTP,
// timeout— sale de la librería estándar configurando `http.Transport` y
// `http.Client.CheckRedirect`. Una librería HTTP de terceros no agregaría
// nada acá y sí sumaría peso a un binario con techo de 80 MB
// (.claude/rules/technical.md punto 8).
//
// # Qué NO vive acá
//
// Variables (`{{var}}`), autenticación y scripts entran en fases
// posteriores del plan (.claude/specs/http-client.md). Este paquete recibe
// una petición **ya resuelta**: quien la resuelva es problema de la capa de
// arriba, y esa separación es lo que permite que un script de pre-request
// (F5) modifique la petición sin que el motor se entere.
package httpclient

// BodyMode es cómo se codifica el cuerpo. Los valores coinciden con los de
// Postman a propósito: son la clave del import/export (F6) y traducirlos dos
// veces sería una fuente de errores gratis.
const (
	BodyNone       = "none"
	BodyRaw        = "raw"
	BodyFormData   = "formdata"
	BodyURLEncoded = "urlencoded"
	BodyBinary     = "binary"
	BodyGraphQL    = "graphql"
)

// Versiones de HTTP ofrecidas. "auto" deja que Go negocie (ALPN), que es lo
// correcto salvo que se esté depurando un servidor que se comporta distinto
// según la versión — el motivo real por el que Postman lo expone.
const (
	HTTPAuto = "auto"
	HTTP11   = "1.1"
	HTTP2    = "2"
)

// KeyValue es una fila de las tablas de params, headers y variables de ruta.
// Enabled refleja el checkbox: una fila desmarcada se conserva (es un dato
// que el usuario escribió) pero no viaja.
type KeyValue struct {
	Key         string `json:"key"`
	Value       string `json:"value"`
	Enabled     bool   `json:"enabled"`
	Description string `json:"description,omitempty"`
}

// Body es el cuerpo de la petición. En F1 solo se envía Raw; el resto de los
// modos están en el tipo desde ahora porque el import de Postman (F6) los
// tiene que poder guardar aunque todavía no se ejecuten, y cambiar la forma
// del tipo después obligaría a una migración de datos.
type Body struct {
	Mode string `json:"mode"`
	Raw  string `json:"raw,omitempty"`
	// RawLang es solo presentación: qué resaltador y qué formateador usar
	// ("json", "xml", "text", "html", "javascript"). No cambia lo que se
	// manda.
	RawLang string `json:"rawLang,omitempty"`
	// FormData y URLEncoded se persisten desde F1 y se envían desde F3.
	FormData   []FormField `json:"formData,omitempty"`
	URLEncoded []KeyValue  `json:"urlEncoded,omitempty"`
	// BinaryPath es un archivo del disco usado como cuerpo entero (F3).
	BinaryPath string `json:"binaryPath,omitempty"`
	// GraphQL: query + variables como texto JSON (F3).
	GraphQLQuery     string `json:"graphqlQuery,omitempty"`
	GraphQLVariables string `json:"graphqlVariables,omitempty"`
}

// FormField es una fila de multipart. Type distingue "text" de "file"; para
// "file" el valor es una ruta del disco, no el contenido.
type FormField struct {
	Key         string `json:"key"`
	Value       string `json:"value"`
	Type        string `json:"type"`
	Enabled     bool   `json:"enabled"`
	Description string `json:"description,omitempty"`
}

// Settings son las opciones por petición de la pestaña Settings.
//
// Todas tienen un default explícito en DefaultSettings en vez de depender
// del cero de Go: el cero de VerifyTLS es false, y que una petición nueva
// naciera sin verificar certificados por accidente es exactamente el tipo de
// default que no se puede tener.
type Settings struct {
	TimeoutMs               int    `json:"timeoutMs"`
	VerifyTLS               bool   `json:"verifyTls"`
	FollowRedirects         bool   `json:"followRedirects"`
	MaxRedirects            int    `json:"maxRedirects"`
	KeepMethodOnRedirect    bool   `json:"keepMethodOnRedirect"`
	KeepAuthOnRedirect      bool   `json:"keepAuthOnRedirect"`
	RemoveRefererOnRedirect bool   `json:"removeRefererOnRedirect"`
	HTTPVersion             string `json:"httpVersion"`
	// MaxBodyBytes es el tope de cuerpo de respuesta que se trae a memoria.
	// Pasado ese tope la respuesta llega marcada como truncada; volcarla a
	// disco y ofrecer "guardar como" es trabajo de F3.
	MaxBodyBytes int64 `json:"maxBodyBytes"`
}

// DefaultSettings son los valores de una petición nueva.
//
// VerifyTLS **true** aunque la captura del usuario muestre OFF: ese OFF es
// una elección deliberada suya para un entorno concreto, y un default que
// desactiva la verificación de certificados convierte una decisión
// consciente en un descuido silencioso. Se apaga por request cuando hace
// falta, y la UI lo muestra encendido en rojo.
func DefaultSettings() Settings {
	return Settings{
		TimeoutMs:       60_000,
		VerifyTLS:       true,
		FollowRedirects: true,
		MaxRedirects:    10,
		HTTPVersion:     HTTPAuto,
		MaxBodyBytes:    8 << 20, // 8 MiB
	}
}

// Request es una petición lista para enviar: sin variables por resolver, sin
// auth por calcular.
type Request struct {
	Method   string     `json:"method"`
	URL      string     `json:"url"`
	Params   []KeyValue `json:"params,omitempty"`
	PathVars []KeyValue `json:"pathVars,omitempty"`
	Headers  []KeyValue `json:"headers,omitempty"`
	Body     Body       `json:"body"`
	Settings Settings   `json:"settings"`
	// Auth ya viene RESUELTA por la cadena de herencia: el motor firma con
	// lo que recibe y no sabe de carpetas ni de colecciones. Esa separación
	// es lo que permite probar la firma sin montar un árbol entero.
	Auth Auth `json:"auth"`
}

// Response es lo que la UI necesita para dibujar el panel de respuesta.
type Response struct {
	Status     int        `json:"status"`
	StatusText string     `json:"statusText"`
	Headers    []KeyValue `json:"headers"`
	// Body es texto cuando el contenido es texto. Para binario viene vacío y
	// BodyBase64 trae los bytes, para que la UI pueda previsualizar una
	// imagen sin que el motor decida por ella.
	Body       string `json:"body"`
	BodyBase64 string `json:"bodyBase64,omitempty"`
	IsBinary   bool   `json:"isBinary"`
	// Truncated indica que el cuerpo superó MaxBodyBytes y lo que llegó está
	// cortado. Se reporta en vez de fallar: una respuesta enorme sigue
	// sirviendo para ver el status y los headers.
	Truncated  bool  `json:"truncated"`
	SizeBytes  int64 `json:"sizeBytes"`
	DurationMs int64 `json:"durationMs"`
	// URL final después de seguir redirecciones, y cuántas se siguieron.
	FinalURL  string `json:"finalUrl"`
	Redirects int    `json:"redirects"`
	// ContentType normalizado (sin parámetros), para elegir resaltador.
	ContentType string `json:"contentType"`
	// Lang es el lenguaje sugerido para el visor ("json", "xml", "html",
	// "text"). Lo decide el motor porque conoce el Content-Type real y el
	// olfateo del cuerpo; la UI no tiene por qué repetir esa lógica.
	Lang string `json:"lang"`
	// SpillPath es la ruta del archivo temporal con el cuerpo COMPLETO,
	// cuando superó el tope y lo que se muestra viene cortado. Vacío
	// significa que el cuerpo entero está en memoria. Es lo que permite que
	// "guardar como" sobre una descarga grande guarde el archivo entero y no
	// los primeros megabytes.
	SpillPath string `json:"spillPath,omitempty"`
	// Filename es el nombre propuesto al guardar: sale del
	// Content-Disposition y, si no hay, del último tramo de la URL.
	Filename string `json:"filename,omitempty"`
}
