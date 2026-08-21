package httpclient

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// Runner ejecuta peticiones y lleva el registro de las que están en vuelo,
// para poder cancelarlas.
//
// Es el mismo patrón que git.Runner: un objeto de larga vida en App, sin
// estado por petición más allá del registro de cancelación. El
// http.Transport NO se comparte entre peticiones porque cada una puede pedir
// una configuración de TLS o de versión de HTTP distinta, y un transport
// compartido reusaría conexiones establecidas con la configuración de otra
// — que es exactamente el bug donde "desactivé la verificación TLS y sigue
// fallando" (o peor: al revés).
type Runner struct {
	mu      sync.Mutex
	inFlght map[string]context.CancelFunc
	// Jars son los tarros de cookies, uno por entorno. El transport no se
	// comparte entre peticiones pero el tarro SÍ tiene que compartirse: es
	// justamente lo que hace que el login de una petición valga para la
	// siguiente. Ver jar.go.
	Jars *JarStore

	// spills son los archivos temporales con el cuerpo completo de las
	// respuestas que superaron el tope de memoria. Se registran para poder
	// borrarlos al cerrar: son de 8 MiB para arriba cada uno, y en macOS el
	// temporal del sistema solo se limpia al reiniciar.
	spillMu sync.Mutex
	spills  []string
}

func NewRunner() *Runner {
	return &Runner{inFlght: map[string]context.CancelFunc{}, Jars: NewJarStore()}
}

// Cancel aborta la petición en vuelo con ese id. Cancelar algo que ya
// terminó no es un error: la UI puede pedirlo justo cuando la respuesta ya
// venía en camino.
func (r *Runner) Cancel(execID string) {
	r.mu.Lock()
	cancel := r.inFlght[execID]
	r.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (r *Runner) track(execID string, cancel context.CancelFunc) {
	r.mu.Lock()
	r.inFlght[execID] = cancel
	r.mu.Unlock()
}

func (r *Runner) untrack(execID string) {
	r.mu.Lock()
	delete(r.inFlght, execID)
	r.mu.Unlock()
}

// Send arma y ejecuta la petición.
//
// execID lo elige quien llama para poder cancelar sin esperar a que Send
// devuelva; vacío significa "no cancelable".
// Send arma y ejecuta la petición usando el tarro de cookies del entorno
// indicado. `envID` vacío es el tarro de "sin entorno", que también existe.
func (r *Runner) SendWithJar(execID, envID string, req Request) (*Response, error) {
	return r.send(execID, envID, req)
}

func (r *Runner) Send(execID string, req Request) (*Response, error) {
	return r.send(execID, "", req)
}

func (r *Runner) send(execID, envID string, req Request) (*Response, error) {
	settings := normalizeSettings(req.Settings)

	target, err := buildURL(req)
	if err != nil {
		return nil, err
	}

	body, contentType, size, closers, err := buildBody(req.Body)
	if err != nil {
		return nil, err
	}
	// Los archivos abiertos para el cuerpo se cierran pase lo que pase: un
	// descriptor filtrado por petición fallida es un archivo que el usuario
	// no puede borrar ni mover hasta cerrar la app.
	defer func() {
		for _, c := range closers {
			c.Close()
		}
	}()

	timeout := time.Duration(settings.TimeoutMs) * time.Millisecond
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	if execID != "" {
		r.track(execID, cancel)
		defer r.untrack(execID)
	}

	method := strings.ToUpper(strings.TrimSpace(req.Method))
	if method == "" {
		method = http.MethodGet
	}

	// El cuerpo se materializa en memoria SOLO cuando hace falta firmarlo o
	// reenviarlo: AWS SigV4 hashea el cuerpo, y Digest tiene que repetir la
	// petición después del desafío. Para todo lo demás sigue siendo un
	// lector, que es lo que mantiene el streaming de archivos grandes.
	var signingBody []byte
	needsReplay := req.Auth.Type == AuthAWSv4 || req.Auth.Type == AuthDigest
	if needsReplay && body != nil {
		signingBody, err = io.ReadAll(body)
		if err != nil {
			return nil, fmt.Errorf("leyendo el cuerpo para firmarlo: %w", err)
		}
		body = bytes.NewReader(signingBody)
		size = int64(len(signingBody))
	}

	newRequest := func(reader io.Reader) (*http.Request, error) {
		hreq, err := http.NewRequestWithContext(ctx, method, target, reader)
		if err != nil {
			return nil, fmt.Errorf("no se pudo armar la petición: %w", err)
		}
		// Content-Type derivado del modo del cuerpo primero, para que un
		// header escrito a mano lo pise: si alguien puso
		// "application/vnd.api+json" sobre un cuerpo raw JSON, gana el suyo.
		if contentType != "" {
			hreq.Header.Set("Content-Type", contentType)
		}
		// -1 significa "no se sabe" (multipart en streaming): se deja que Go
		// use chunked. Con un tamaño conocido se informa, que es lo que
		// aceptan los servidores que rechazan una subida chunked.
		if size >= 0 {
			hreq.ContentLength = size
		}
		applyHeaders(hreq, req.Headers)
		return hreq, nil
	}

	hreq, err := newRequest(body)
	if err != nil {
		return nil, err
	}
	// La firma va DESPUÉS de los headers escritos a mano: un Authorization
	// puesto por la autenticación tiene que ganarle a uno viejo que quedó en
	// la tabla, no al revés.
	if err := applyAuth(hreq, req.Auth, signingBody); err != nil {
		return nil, err
	}

	client, redirects := buildClient(settings)
	// El tarro va en el cliente y no en las cabeceras: así net/http se ocupa
	// de las reglas de dominio, de path y de caducidad, y las cookies que
	// llegan por una redirección también se guardan.
	if r.Jars != nil {
		client.Jar = r.Jars.For(envID)
		r.Jars.Note(envID, hreq.URL.Hostname())
	}

	started := time.Now()
	hresp, err := client.Do(hreq)
	if err != nil {
		return nil, describeSendError(err, ctx, timeout)
	}

	// Digest necesita el desafío del servidor: la primera petición sale sin
	// firmar, el 401 trae el nonce, y recién ahí se puede calcular la
	// respuesta. Un solo reintento — si el segundo 401 llega, las
	// credenciales están mal y repetir no lo va a arreglar.
	if hresp.StatusCode == http.StatusUnauthorized && req.Auth.Type == AuthDigest {
		if challenge, ok := parseDigestChallenge(hresp.Header.Get("WWW-Authenticate")); ok {
			hresp.Body.Close()
			retry, err := newRequest(bytes.NewReader(signingBody))
			if err != nil {
				return nil, err
			}
			header, err := digestAuthHeader(req.Auth, challenge, method, retry.URL.RequestURI())
			if err != nil {
				return nil, err
			}
			retry.Header.Set("Authorization", header)
			hresp, err = client.Do(retry)
			if err != nil {
				return nil, describeSendError(err, ctx, timeout)
			}
		}
	}
	defer hresp.Body.Close()

	resp, err := readResponse(hresp, settings)
	if err != nil {
		return nil, err
	}
	r.noteSpill(resp.SpillPath)
	resp.DurationMs = time.Since(started).Milliseconds()
	resp.Redirects = *redirects
	return resp, nil
}

// normalizeSettings completa lo que venga en cero con los defaults.
//
// # El caso peligroso: la estructura ENTERA en cero
//
// Rellenar campo por campo funciona para los números, pero NO para los
// booleanos: el cero de VerifyTLS es false, así que una petición que llega
// sin settings —el frontend todavía cargándolos, un ítem guardado por una
// versión anterior, un import que no los trae— se enviaba **sin verificar
// el certificado del servidor**, en silencio. Es exactamente lo que el
// comentario de DefaultSettings advierte que no puede pasar, y pasaba una
// función más abajo.
//
// El desempate es TimeoutMs: la UI impone un mínimo de un segundo y
// HttpBuildRequest siempre rellena los defaults, así que un timeout en cero
// no significa "sin límite", significa "acá no llenó nadie". En ese caso se
// descarta la estructura entera y se usan los defaults, en vez de quedarse
// con la mitad segura y la mitad peligrosa.
func normalizeSettings(s Settings) Settings {
	d := DefaultSettings()
	if s.TimeoutMs <= 0 {
		return d
	}
	if s.MaxRedirects <= 0 {
		s.MaxRedirects = d.MaxRedirects
	}
	if s.MaxBodyBytes <= 0 {
		s.MaxBodyBytes = d.MaxBodyBytes
	}
	if s.HTTPVersion == "" {
		s.HTTPVersion = d.HTTPVersion
	}
	return s
}

// PreviewURL arma la URL final sin enviar nada — lo que la UI muestra junto
// al resultado, y lo que se archiva en el historial. Es la MISMA función que
// usa Send: mostrar una URL calculada de otra forma que la que sale por el
// cable convertiría el panel en una fuente de confusión justo cuando se lo
// consulta para entender un fallo.
func PreviewURL(req Request) (string, error) { return buildURL(req) }

// buildURL aplica las variables de ruta y los query params sobre la URL
// base.
//
// Las variables de ruta se sustituyen por segmento y no con un reemplazo de
// texto: `:id` dentro de `/users/:id/:idCard` con un replace ingenuo pisaría
// también el prefijo de `:idCard`. Se parte por "/" y se compara el segmento
// entero, que además es lo que hace Postman.
func buildURL(req Request) (string, error) {
	raw := strings.TrimSpace(req.URL)
	if raw == "" {
		return "", errors.New("la URL no puede estar vacía")
	}
	// Sin esquema, http:// — es lo que la gente escribe cuando prueba contra
	// localhost, y fallar con "unsupported protocol scheme" ahí es hostil.
	if !strings.Contains(raw, "://") {
		raw = "http://" + raw
	}

	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("URL inválida: %w", err)
	}

	if len(req.PathVars) > 0 {
		vars := map[string]string{}
		for _, v := range req.PathVars {
			if v.Key != "" {
				vars[v.Key] = v.Value
			}
		}
		// Se trabaja sobre la ruta ESCAPADA y se escriben las dos formas.
		//
		// Antes se sustituía sobre `u.Path` —la forma DECODIFICADA— con el
		// valor ya escapado, y `u.String()` lo volvía a escapar al final: un
		// `:id` con valor "hola mundo" salía como `hola%2520mundo`, y el
		// servidor recibía el texto literal "hola%20mundo" como id. Cualquier
		// valor con espacio, acento o `%` viajaba mal.
		//
		// `u.RawPath` solo lo usa Go si es una codificación válida de
		// `u.Path`; escribir las dos a la vez es lo que garantiza que lo sea.
		segments := strings.Split(u.EscapedPath(), "/")
		for i, seg := range segments {
			if !strings.HasPrefix(seg, ":") || len(seg) == 1 {
				continue
			}
			if val, ok := vars[seg[1:]]; ok {
				segments[i] = url.PathEscape(val)
			}
		}
		joined := strings.Join(segments, "/")
		decoded, err := url.PathUnescape(joined)
		if err != nil {
			// Solo puede pasar con un `%` mal formado en la URL original, que
			// ya venía roto: se deja la ruta como estaba en vez de romperla
			// más.
			return "", fmt.Errorf("URL inválida: %w", err)
		}
		u.Path, u.RawPath = decoded, joined
	}

	if len(req.Params) > 0 {
		q := u.Query()
		for _, p := range req.Params {
			if !p.Enabled || p.Key == "" {
				continue
			}
			q.Add(p.Key, p.Value)
		}
		u.RawQuery = q.Encode()
	} else {
		u.RawQuery = sanitizeRawQuery(u.RawQuery)
	}
	return u.String(), nil
}

// sanitizeRawQuery escapa los caracteres que no pueden viajar literales en
// una query, sin reordenar nada.
//
// Hace falta porque una URL pegada de otro lado —o escrita a mano con un
// valor que lleva espacio— produce una línea de petición inválida, y el
// servidor contesta 400 **sin invocar el handler**: desde la app se ve una
// respuesta legítima con un código raro, y la causa (un espacio) no aparece
// por ningún lado.
//
// No se usa url.Values.Encode() para esto, que sería una línea: Encode()
// ORDENA los parámetros alfabéticamente, y hay APIs —y toda URL prefirmada—
// donde el orden es parte del contrato. Escapar en el lugar preserva lo que
// el usuario escribió.
func sanitizeRawQuery(raw string) string {
	if raw == "" {
		return raw
	}
	var b strings.Builder
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		switch {
		// Delimitadores y caracteres ya válidos se dejan intactos.
		case c == '&' || c == '=' || c == ';' || c == ',' || c == '/' || c == ':' ||
			c == '?' || c == '@' || c == '!' || c == '$' || c == '\'' || c == '(' ||
			c == ')' || c == '*' || c == '+' || c == '-' || c == '.' || c == '_' || c == '~':
			b.WriteByte(c)
		case c == '%':
			// Una secuencia ya escapada se respeta; un '%' suelto se escapa,
			// porque si no la URL entera queda inválida.
			if i+2 < len(raw) && isHexDigit(raw[i+1]) && isHexDigit(raw[i+2]) {
				b.WriteString(raw[i : i+3])
				i += 2
			} else {
				b.WriteString("%25")
			}
		case (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9'):
			b.WriteByte(c)
		default:
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

func isHexDigit(c byte) bool {
	return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
}

// buildBody devuelve el cuerpo, su Content-Type y —cuando se conoce— su
// tamaño, además de los archivos a cerrar cuando la petición termina.
//
// El tamaño se devuelve porque `http.Request.ContentLength` solo se rellena
// solo para los lectores que la librería reconoce (bytes.Reader,
// strings.Reader). Un cuerpo que sale de un archivo o de un pipe se manda
// con `Transfer-Encoding: chunked`, y hay servidores —PHP con algunas
// configuraciones, varios proxies viejos— que rechazan una subida chunked.
// Cuando el tamaño se puede saber de antemano se informa; cuando no
// (multipart en streaming), se acepta chunked a cambio de no cargar el
// archivo entero en memoria.
func buildBody(b Body) (body io.Reader, contentType string, size int64, closers []io.Closer, err error) {
	switch b.Mode {
	case "", BodyNone:
		return nil, "", 0, nil, nil

	case BodyRaw:
		if b.Raw == "" {
			return nil, "", 0, nil, nil
		}
		return strings.NewReader(b.Raw), rawContentType(b.RawLang), int64(len(b.Raw)), nil, nil

	case BodyGraphQL:
		// GraphQL sobre HTTP es un JSON con `query` y `variables`; se arma
		// acá en vez de pedirle al usuario que lo escriba a mano, que es lo
		// que hace que el modo exista.
		payload := map[string]any{"query": b.GraphQLQuery}
		if strings.TrimSpace(b.GraphQLVariables) != "" {
			var vars any
			if err := json.Unmarshal([]byte(b.GraphQLVariables), &vars); err != nil {
				return nil, "", 0, nil, fmt.Errorf("las variables de GraphQL no son JSON válido: %w", err)
			}
			payload["variables"] = vars
		}
		encoded, err := json.Marshal(payload)
		if err != nil {
			return nil, "", 0, nil, err
		}
		return bytes.NewReader(encoded), "application/json", int64(len(encoded)), nil, nil

	case BodyURLEncoded:
		form := url.Values{}
		for _, kv := range b.URLEncoded {
			if !kv.Enabled || kv.Key == "" {
				continue
			}
			form.Add(kv.Key, kv.Value)
		}
		encoded := form.Encode()
		return strings.NewReader(encoded), "application/x-www-form-urlencoded", int64(len(encoded)), nil, nil

	case BodyBinary:
		if strings.TrimSpace(b.BinaryPath) == "" {
			return nil, "", 0, nil, errors.New("elegí un archivo para mandar como cuerpo")
		}
		f, err := os.Open(b.BinaryPath)
		if err != nil {
			return nil, "", 0, nil, fmt.Errorf("no se pudo abrir %q: %w", b.BinaryPath, err)
		}
		info, err := f.Stat()
		if err != nil {
			f.Close()
			return nil, "", 0, nil, fmt.Errorf("no se pudo leer %q: %w", b.BinaryPath, err)
		}
		// Tipo por extensión; si no se reconoce, el genérico. No se olfatea
		// el contenido: leer los primeros bytes para adivinar obligaría a
		// rebobinar el archivo y el beneficio es marginal frente a que el
		// usuario ponga el header a mano si le importa.
		ctype := mime.TypeByExtension(filepath.Ext(b.BinaryPath))
		if ctype == "" {
			ctype = "application/octet-stream"
		}
		return f, ctype, info.Size(), []io.Closer{f}, nil

	case BodyFormData:
		return buildMultipart(b.FormData)

	default:
		return nil, "", 0, nil, fmt.Errorf("tipo de cuerpo desconocido: %q", b.Mode)
	}
}

// buildMultipart arma un form-data en STREAMING sobre un io.Pipe.
//
// Se escribe mientras se envía en vez de armar el cuerpo entero en memoria:
// una subida de 500 MB no puede costar 500 MB de RAM. El costo es que el
// tamaño no se conoce de antemano, así que la petición sale chunked.
//
// El goroutine cierra SIEMPRE el lado de escritura con CloseWithError: si se
// va sin cerrar, el lector queda esperando para siempre y la petición se
// cuelga hasta el timeout sin decir por qué.
func buildMultipart(fields []FormField) (io.Reader, string, int64, []io.Closer, error) {
	// Los archivos se abren ANTES de arrancar el envío: si uno no existe, es
	// mejor fallar acá —con el nombre del archivo— que a mitad de la subida,
	// cuando el servidor ya recibió medio cuerpo.
	var closers []io.Closer
	opened := map[int]*os.File{}
	for i, f := range fields {
		if !f.Enabled || f.Type != "file" || f.Value == "" {
			continue
		}
		file, err := os.Open(f.Value)
		if err != nil {
			for _, c := range closers {
				c.Close()
			}
			return nil, "", 0, nil, fmt.Errorf("no se pudo abrir %q: %w", f.Value, err)
		}
		opened[i] = file
		closers = append(closers, file)
	}

	pr, pw := io.Pipe()
	writer := multipart.NewWriter(pw)

	go func() {
		var err error
		defer func() {
			// El orden importa: primero se cierra el writer (que escribe el
			// delimitador final del multipart), después el pipe.
			if cerr := writer.Close(); err == nil {
				err = cerr
			}
			pw.CloseWithError(err)
		}()

		for i, f := range fields {
			if !f.Enabled || f.Key == "" {
				continue
			}
			if f.Type == "file" {
				file := opened[i]
				if file == nil {
					continue
				}
				var part io.Writer
				part, err = writer.CreateFormFile(f.Key, filepath.Base(f.Value))
				if err != nil {
					return
				}
				if _, err = io.Copy(part, file); err != nil {
					return
				}
				continue
			}
			if err = writer.WriteField(f.Key, f.Value); err != nil {
				return
			}
		}
	}()

	return pr, writer.FormDataContentType(), -1, closers, nil
}

func rawContentType(lang string) string {
	switch lang {
	case "json":
		return "application/json"
	case "xml":
		return "application/xml"
	case "html":
		return "text/html"
	case "javascript":
		return "application/javascript"
	case "text", "":
		return "text/plain"
	default:
		return "text/plain"
	}
}

// applyHeaders escribe los headers habilitados. Set y no Add para la primera
// aparición de cada clave, Add para las repetidas: hay headers que
// legítimamente van varias veces (Cookie no, pero Accept o Link sí) y
// aplastarlos cambiaría la petición.
func applyHeaders(hreq *http.Request, headers []KeyValue) {
	seen := map[string]bool{}
	for _, h := range headers {
		if !h.Enabled || strings.TrimSpace(h.Key) == "" {
			continue
		}
		key := http.CanonicalHeaderKey(strings.TrimSpace(h.Key))
		// Host no es un header común: net/http lo lee de req.Host, y
		// ponerlo en el mapa no hace nada. Sin este caso, escribir un Host
		// a mano se ignoraba en silencio.
		if key == "Host" {
			hreq.Host = h.Value
			continue
		}
		if seen[key] {
			hreq.Header.Add(key, h.Value)
			continue
		}
		seen[key] = true
		hreq.Header.Set(key, h.Value)
	}
}

// buildClient arma el cliente según los settings y devuelve un contador de
// redirecciones seguidas, que se lee después de la respuesta.
func buildClient(s Settings) (*http.Client, *int) {
	transport := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		TLSClientConfig:       &tls.Config{InsecureSkipVerify: !s.VerifyTLS},
		ForceAttemptHTTP2:     s.HTTPVersion != HTTP11,
		MaxIdleConns:          10,
		IdleConnTimeout:       30 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
	}
	if s.HTTPVersion == HTTP11 {
		// Forzar 1.1 es desactivar la negociación por ALPN: con el mapa
		// vacío pero no nil, net/http no promueve la conexión a h2.
		transport.TLSNextProto = map[string]func(string, *tls.Conn) http.RoundTripper{}
	}

	redirects := 0
	client := &http.Client{
		Transport: transport,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if !s.FollowRedirects {
				return http.ErrUseLastResponse
			}
			if len(via) >= s.MaxRedirects {
				return fmt.Errorf("se superaron las %d redirecciones permitidas", s.MaxRedirects)
			}
			redirects = len(via)

			last := via[len(via)-1]
			if s.KeepMethodOnRedirect {
				// Go convierte a GET en 301/302/303 salvo que se lo impida.
				// Repetir el método original es lo que pide la opción
				// "Follow original HTTP Method".
				req.Method = last.Method
			}
			if s.RemoveRefererOnRedirect {
				req.Header.Del("Referer")
			}
			// net/http YA quita Authorization al cambiar de host; la opción
			// "Follow Authorization header" pide lo contrario, así que se
			// vuelve a poner a mano y solo si el usuario lo pidió. Mandar
			// credenciales a otro host es filtrarlas, y por eso nunca es el
			// default.
			if s.KeepAuthOnRedirect {
				if auth := last.Header.Get("Authorization"); auth != "" && req.Header.Get("Authorization") == "" {
					req.Header.Set("Authorization", auth)
				}
			}
			return nil
		},
	}
	return client, &redirects
}

// describeSendError traduce el error de transporte a algo accionable.
//
// El error crudo de Go para un timeout es
// `context deadline exceeded (Client.Timeout exceeded...)`, que no dice
// cuánto era el límite ni que se puede cambiar — dos cosas que el usuario
// necesita justo en ese momento.
func describeSendError(err error, ctx context.Context, timeout time.Duration) error {
	if ctx.Err() == context.DeadlineExceeded {
		return fmt.Errorf("la petición superó el tiempo límite de %s (se cambia en Settings)", timeout)
	}
	if ctx.Err() == context.Canceled {
		return errors.New("petición cancelada")
	}
	var certErr *tls.CertificateVerificationError
	if errors.As(err, &certErr) {
		return fmt.Errorf("el certificado del servidor no se pudo verificar: %w — si es un entorno interno con certificado propio, apagá la verificación TLS en Settings", err)
	}
	return err
}

// readResponse lee el cuerpo con tope y arma la respuesta.
//
// Cuando el cuerpo supera el tope NO se descarta el resto: lo que entra se
// devuelve para mostrar y **el cuerpo completo se vuelca a un archivo
// temporal**, cuya ruta viaja en SpillPath. Sin eso, "guardar como" sobre
// una descarga de 200 MB guardaría los primeros 8 MB — un archivo corrupto
// con nombre de archivo bueno, que es peor que no ofrecer el botón.
// noteSpill registra un archivo temporal para borrarlo al cerrar la app.
func (r *Runner) noteSpill(path string) {
	if path == "" {
		return
	}
	r.spillMu.Lock()
	defer r.spillMu.Unlock()
	r.spills = append(r.spills, path)
}

// CleanSpills borra los temporales de esta sesión. Lo llama el apagado de la
// aplicación.
//
// Al cerrar y no al recibir la respuesta siguiente: mientras la pestaña sigue
// mostrando una respuesta cortada, su botón «Guardar…» promete el cuerpo
// entero, y ese cuerpo es justamente este archivo. Borrarlo antes convertiría
// el botón en un error.
func (r *Runner) CleanSpills() {
	r.spillMu.Lock()
	paths := r.spills
	r.spills = nil
	r.spillMu.Unlock()
	for _, p := range paths {
		_ = os.Remove(p)
	}
}

func readResponse(hresp *http.Response, s Settings) (*Response, error) {
	// Se lee un byte de más que el tope: es lo que distingue "entró justo"
	// de "se cortó", sin tener que confiar en Content-Length (que puede
	// faltar o mentir).
	limited := io.LimitReader(hresp.Body, s.MaxBodyBytes+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		return nil, fmt.Errorf("leyendo la respuesta: %w", err)
	}

	truncated := int64(len(data)) > s.MaxBodyBytes
	spillPath := ""
	totalSize := int64(len(data))
	if truncated {
		spillPath, totalSize, err = spillToFile(data, hresp.Body)
		if err != nil {
			return nil, err
		}
		data = data[:s.MaxBodyBytes]
	}


	resp := &Response{
		Status:     hresp.StatusCode,
		StatusText: strings.TrimSpace(strings.TrimPrefix(hresp.Status, fmt.Sprint(hresp.StatusCode))),
		Headers:    flattenHeaders(hresp.Header),
		Truncated:  truncated,
		SizeBytes:  totalSize,
		FinalURL:   hresp.Request.URL.String(),
		SpillPath:  spillPath,
		Filename:   suggestedFilename(hresp),
	}

	ctype := hresp.Header.Get("Content-Type")
	if mt, _, err := mime.ParseMediaType(ctype); err == nil {
		resp.ContentType = mt
	} else {
		resp.ContentType = strings.TrimSpace(strings.SplitN(ctype, ";", 2)[0])
	}

	if isTextual(resp.ContentType, data) {
		resp.Body = string(data)
		resp.Lang = langFor(resp.ContentType, data)
	} else {
		resp.IsBinary = true
		resp.BodyBase64 = base64.StdEncoding.EncodeToString(data)
		resp.Lang = "text"
	}
	return resp, nil
}

// spillToFile escribe lo ya leído más el resto del cuerpo en un archivo
// temporal, y devuelve su ruta y el tamaño total.
//
// El archivo queda en el temporal del sistema y NO se borra acá: la UI puede
// ofrecer guardarlo minutos después. Es el sistema operativo el que limpia
// ese directorio, que es el trato normal para un archivo de trabajo.
func spillToFile(head []byte, rest io.Reader) (string, int64, error) {
	f, err := os.CreateTemp("", "mini-tools-http-*.bin")
	if err != nil {
		return "", 0, fmt.Errorf("no se pudo crear el archivo temporal para la respuesta: %w", err)
	}
	defer f.Close()

	n, err := f.Write(head)
	if err != nil {
		os.Remove(f.Name())
		return "", 0, fmt.Errorf("escribiendo la respuesta: %w", err)
	}
	copied, err := io.Copy(f, rest)
	if err != nil {
		os.Remove(f.Name())
		return "", 0, fmt.Errorf("escribiendo la respuesta: %w", err)
	}
	return f.Name(), int64(n) + copied, nil
}

// suggestedFilename saca el nombre de archivo del Content-Disposition, y si
// no hay, del último tramo de la URL. Es lo que se propone al guardar: un
// "download.bin" genérico obliga a escribirlo a mano justo cuando el
// servidor ya lo dijo.
func suggestedFilename(hresp *http.Response) string {
	if cd := hresp.Header.Get("Content-Disposition"); cd != "" {
		if _, params, err := mime.ParseMediaType(cd); err == nil {
			if name := strings.TrimSpace(params["filename"]); name != "" {
				// Solo el nombre: un Content-Disposition con "../" adentro
				// es un intento de escribir fuera de la carpeta elegida.
				return filepath.Base(name)
			}
		}
	}
	if hresp.Request != nil && hresp.Request.URL != nil {
		if base := filepath.Base(hresp.Request.URL.Path); base != "" && base != "/" && base != "." {
			return base
		}
	}
	return ""
}

func flattenHeaders(h http.Header) []KeyValue {
	out := make([]KeyValue, 0, len(h))
	for key, values := range h {
		for _, v := range values {
			out = append(out, KeyValue{Key: key, Value: v, Enabled: true})
		}
	}
	return out
}

// isTextual decide si el cuerpo se puede mostrar como texto.
//
// Se mira el Content-Type primero y los bytes después, en ese orden y no al
// revés: un servidor que declara `application/json` y manda UTF-8 válido es
// texto aunque el olfateo dude, y uno que no declara nada pero manda UTF-8
// sin bytes nulos también. El olfateo solo decide cuando el tipo no alcanza.
func isTextual(contentType string, data []byte) bool {
	ct := strings.ToLower(contentType)
	switch {
	case strings.HasPrefix(ct, "text/"):
		return true
	case strings.Contains(ct, "json"), strings.Contains(ct, "xml"),
		strings.Contains(ct, "javascript"), strings.Contains(ct, "html"),
		strings.Contains(ct, "x-www-form-urlencoded"), strings.Contains(ct, "csv"):
		return true
	case strings.HasPrefix(ct, "image/"), strings.HasPrefix(ct, "audio/"),
		strings.HasPrefix(ct, "video/"), strings.HasPrefix(ct, "font/"),
		ct == "application/octet-stream", ct == "application/pdf",
		strings.Contains(ct, "zip"), strings.Contains(ct, "gzip"):
		return false
	}
	if len(data) == 0 {
		return true
	}
	// Sin tipo útil: UTF-8 válido y sin nulos es texto.
	for _, b := range data {
		if b == 0 {
			return false
		}
	}
	return utf8.Valid(data)
}

// langFor elige el resaltador del visor.
func langFor(contentType string, data []byte) string {
	ct := strings.ToLower(contentType)
	switch {
	case strings.Contains(ct, "json"):
		return "json"
	case strings.Contains(ct, "xml"), strings.Contains(ct, "xhtml"):
		return "xml"
	case strings.Contains(ct, "html"):
		return "html"
	case strings.Contains(ct, "javascript"):
		return "javascript"
	}
	// Sin tipo confiable, se mira el primer carácter que no sea espacio:
	// muchas APIs devuelven JSON como text/plain, y mostrarlo sin resaltar
	// ni poder formatear es peor que arriesgar una corazonada.
	for _, c := range strings.TrimSpace(string(data)) {
		switch c {
		case '{', '[':
			return "json"
		case '<':
			return "xml"
		}
		break
	}
	return "text"
}
