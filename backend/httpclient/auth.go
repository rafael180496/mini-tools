package httpclient

import (
	"crypto/hmac"
	"crypto/md5"
	"crypto/rand"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

// Autenticación de una petición.
//
// # Herencia
//
// Una petición puede decir "heredar" y entonces manda la carpeta que la
// contiene; si esa también hereda, manda la colección. Es la cadena de
// Postman y el default de todo lo nuevo, porque es lo que hace que cambiar
// el token de una API sea UNA edición y no treinta.
//
// # Qué se ejecuta y qué solo se preserva
//
// Los tipos de esta lista se ejecutan de verdad. Los que no —OAuth 1.0,
// Hawk, NTLM, Akamai EdgeGrid, ASAP— se guardan tal cual para que el
// import/export no pierda nada, y la UI dice claramente que todavía no se
// ejecutan. Prometer que "funciona" y mandar la petición sin firmar sería
// peor que decir la verdad.
const (
	AuthNone    = "none"
	AuthInherit = "inherit"
	AuthBasic   = "basic"
	AuthBearer  = "bearer"
	AuthAPIKey  = "apikey"
	AuthJWT     = "jwt"
	AuthDigest  = "digest"
	AuthAWSv4   = "awsv4"
	AuthOAuth2  = "oauth2"
)

// executable son los tipos que esta versión sabe firmar.
var executable = map[string]bool{
	AuthNone: true, AuthInherit: true, AuthBasic: true, AuthBearer: true,
	AuthAPIKey: true, AuthJWT: true, AuthDigest: true, AuthAWSv4: true, AuthOAuth2: true,
}

// Auth es la configuración de autenticación, plana y con un discriminador.
//
// Plana y no un campo por tipo porque así se guarda como un solo JSON
// cifrado y el mapeo desde/hacia Postman (que usa `auth.basic[]`,
// `auth.bearer[]`…) queda contenido en un solo lugar, la fase de import.
type Auth struct {
	Type string `json:"type"`

	// Basic / Digest
	Username string `json:"username,omitempty"`
	Password string `json:"password,omitempty"`

	// Bearer
	Token string `json:"token,omitempty"`

	// API Key
	Key   string `json:"key,omitempty"`
	Value string `json:"value,omitempty"`
	// In es "header" o "query". Vacío = header, que es lo habitual.
	In string `json:"in,omitempty"`

	// JWT
	Algorithm      string `json:"algorithm,omitempty"`
	Secret         string `json:"secret,omitempty"`
	SecretBase64   bool   `json:"secretBase64,omitempty"`
	Payload        string `json:"payload,omitempty"`
	HeaderPrefix   string `json:"headerPrefix,omitempty"`
	AddTokenTo     string `json:"addTokenTo,omitempty"`
	QueryParamName string `json:"queryParamName,omitempty"`

	// AWS Signature v4
	AccessKey    string `json:"accessKey,omitempty"`
	SecretKey    string `json:"secretKey,omitempty"`
	SessionToken string `json:"sessionToken,omitempty"`
	Region       string `json:"region,omitempty"`
	Service      string `json:"service,omitempty"`

	// OAuth 2.0
	GrantType      string `json:"grantType,omitempty"`
	AccessTokenURL string `json:"accessTokenUrl,omitempty"`
	AuthURL        string `json:"authUrl,omitempty"`
	ClientID       string `json:"clientId,omitempty"`
	ClientSecret   string `json:"clientSecret,omitempty"`
	Scope          string `json:"scope,omitempty"`
	RefreshToken   string `json:"refreshToken,omitempty"`
	RedirectURI    string `json:"redirectUri,omitempty"`
	// AccessToken y ExpiresAt son el token ya obtenido, cacheado para no
	// pedir uno nuevo en cada envío. Se persisten cifrados como el resto de
	// la auth.
	AccessToken string `json:"accessToken,omitempty"`
	ExpiresAt   int64  `json:"expiresAt,omitempty"`

	// Raw preserva el JSON original de un tipo que esta versión no ejecuta,
	// para que el export lo devuelva intacto.
	Raw string `json:"raw,omitempty"`
}

// Executable reporta si esta versión sabe firmar con este tipo.
func (a Auth) Executable() bool { return a.Type == "" || executable[a.Type] }

// ResolveAuth recorre la cadena de herencia —petición, carpeta(s),
// colección— y devuelve la primera que no diga "heredar".
//
// Una cadena entera en "heredar" termina en "sin autenticación", que es lo
// correcto: significa que nadie configuró ninguna.
func ResolveAuth(chain []Auth) Auth {
	for _, a := range chain {
		if a.Type == "" || a.Type == AuthInherit {
			continue
		}
		return a
	}
	return Auth{Type: AuthNone}
}

// applyAuth firma la petición. Devuelve un error solo cuando la
// configuración es inutilizable; un tipo no ejecutable se reporta con un
// mensaje que dice exactamente eso en vez de mandar la petición sin firmar.
//
// Digest NO se resuelve acá: necesita el desafío del servidor, así que vive
// en el reintento de Send.
func applyAuth(hreq *http.Request, a Auth, bodyForSigning []byte) error {
	switch a.Type {
	case "", AuthNone, AuthInherit, AuthDigest:
		return nil

	case AuthBasic:
		hreq.SetBasicAuth(a.Username, a.Password)
		return nil

	case AuthBearer:
		if strings.TrimSpace(a.Token) == "" {
			return errors.New("falta el token del Bearer")
		}
		hreq.Header.Set("Authorization", "Bearer "+a.Token)
		return nil

	case AuthAPIKey:
		if a.Key == "" {
			return errors.New("falta el nombre de la API key")
		}
		if strings.EqualFold(a.In, "query") {
			q := hreq.URL.Query()
			q.Set(a.Key, a.Value)
			hreq.URL.RawQuery = q.Encode()
			return nil
		}
		hreq.Header.Set(a.Key, a.Value)
		return nil

	case AuthJWT:
		token, err := signJWT(a)
		if err != nil {
			return err
		}
		if strings.EqualFold(a.AddTokenTo, "query") {
			name := a.QueryParamName
			if name == "" {
				name = "token"
			}
			q := hreq.URL.Query()
			q.Set(name, token)
			hreq.URL.RawQuery = q.Encode()
			return nil
		}
		prefix := a.HeaderPrefix
		if prefix == "" {
			prefix = "Bearer"
		}
		hreq.Header.Set("Authorization", strings.TrimSpace(prefix+" "+token))
		return nil

	case AuthAWSv4:
		return signAWSv4(hreq, a, bodyForSigning)

	case AuthOAuth2:
		if strings.TrimSpace(a.AccessToken) == "" {
			return errors.New("no hay un token de OAuth 2.0 todavía: pedí uno desde la pestaña Authorization")
		}
		hreq.Header.Set("Authorization", "Bearer "+a.AccessToken)
		return nil

	default:
		return fmt.Errorf("la autenticación %q se guarda y se exporta, pero esta versión todavía no la firma", a.Type)
	}
}

// AuthAsHeaders devuelve los headers que la autenticación agregaría, para
// que un snippet generado reproduzca la petición completa.
//
// No sirve para enviar —eso lo hace applyAuth sobre el *http.Request— sino
// para MOSTRAR: un fetch de ejemplo sin el Authorization que la aplicación
// sí manda es un snippet que no funciona cuando lo pegan.
//
// Los tipos que necesitan el servidor (Digest) o una petición previa
// (OAuth 2.0 sin token) se omiten: inventar un header ahí sería mostrar algo
// que no es lo que va a viajar.
func AuthAsHeaders(a Auth) []KeyValue {
	one := func(value string) []KeyValue {
		return []KeyValue{{Key: "Authorization", Value: value, Enabled: true}}
	}
	switch a.Type {
	case AuthBasic:
		return one("Basic " + base64.StdEncoding.EncodeToString([]byte(a.Username+":"+a.Password)))
	case AuthBearer:
		if a.Token == "" {
			return nil
		}
		return one("Bearer " + a.Token)
	case AuthOAuth2:
		if a.AccessToken == "" {
			return nil
		}
		return one("Bearer " + a.AccessToken)
	case AuthAPIKey:
		if a.Key == "" || strings.EqualFold(a.In, "query") {
			// En query ya viaja en la URL, que el snippet imprime entera.
			return nil
		}
		return []KeyValue{{Key: a.Key, Value: a.Value, Enabled: true}}
	case AuthJWT:
		token, err := signJWT(a)
		if err != nil {
			return nil
		}
		prefix := a.HeaderPrefix
		if prefix == "" {
			prefix = "Bearer"
		}
		return one(strings.TrimSpace(prefix + " " + token))
	}
	return nil
}

// --- JWT ---------------------------------------------------------------------

// signJWT arma un JWT firmado con HMAC. Solo HS*: RS*/ES* piden manejar
// claves privadas en PEM, que es otra conversación de UI y de
// almacenamiento, y HS256 cubre la enorme mayoría de las APIs internas.
func signJWT(a Auth) (string, error) {
	alg := strings.ToUpper(strings.TrimSpace(a.Algorithm))
	if alg == "" {
		alg = "HS256"
	}
	var newHash func() hash.Hash
	switch alg {
	case "HS256":
		newHash = sha256.New
	case "HS384":
		newHash = sha512.New384
	case "HS512":
		newHash = sha512.New
	default:
		return "", fmt.Errorf("algoritmo de JWT no soportado: %s (esta versión firma HS256, HS384 y HS512)", alg)
	}

	payload := strings.TrimSpace(a.Payload)
	if payload == "" {
		payload = "{}"
	}
	if !json.Valid([]byte(payload)) {
		return "", errors.New("el payload del JWT no es JSON válido")
	}

	secret := []byte(a.Secret)
	if a.SecretBase64 {
		decoded, err := base64.StdEncoding.DecodeString(a.Secret)
		if err != nil {
			return "", fmt.Errorf("el secreto del JWT no es base64 válido: %w", err)
		}
		secret = decoded
	}

	header, _ := json.Marshal(map[string]string{"alg": alg, "typ": "JWT"})
	signingInput := b64url(header) + "." + b64url([]byte(payload))
	mac := hmac.New(newHash, secret)
	mac.Write([]byte(signingInput))
	return signingInput + "." + b64url(mac.Sum(nil)), nil
}

// b64url es base64 sin relleno, que es lo que exige el formato JWT.
func b64url(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// --- AWS Signature v4 --------------------------------------------------------

// signAWSv4 firma con SigV4, implementado a mano.
//
// Sin el SDK de AWS a propósito: traerlo por una función de firma sumaría
// decenas de megabytes a un binario con techo de 80 (technical.md punto 8),
// cuando lo que hace falta son cuatro hashes en un orden concreto. La parte
// difícil de SigV4 no es la criptografía, es la canonicalización — y eso hay
// que escribirlo igual, se use el SDK o no.
func signAWSv4(hreq *http.Request, a Auth, body []byte) error {
	if a.AccessKey == "" || a.SecretKey == "" {
		return errors.New("faltan la Access Key y la Secret Key de AWS")
	}
	region := a.Region
	if region == "" {
		region = "us-east-1"
	}
	service := a.Service
	if service == "" {
		// Se deduce del host (`execute-api.us-east-1.amazonaws.com`), que es
		// lo que evita pedirle al usuario un dato que la URL ya dice.
		service = serviceFromHost(hreq.URL.Host)
	}
	if service == "" {
		return errors.New("no se pudo deducir el servicio de AWS: escribilo en la configuración de la autenticación")
	}

	now := time.Now().UTC()
	amzDate := now.Format("20060102T150405Z")
	dateStamp := now.Format("20060102")

	hreq.Header.Set("X-Amz-Date", amzDate)
	if hreq.Host != "" {
		hreq.Header.Set("Host", hreq.Host)
	}
	if a.SessionToken != "" {
		hreq.Header.Set("X-Amz-Security-Token", a.SessionToken)
	}
	payloadHash := hex.EncodeToString(sha256Sum(body))
	hreq.Header.Set("X-Amz-Content-Sha256", payloadHash)

	// --- petición canónica ---
	canonicalURI := hreq.URL.EscapedPath()
	if canonicalURI == "" {
		canonicalURI = "/"
	}
	canonicalQuery := canonicalQueryString(hreq.URL.Query())

	signedNames, canonicalHeaders := canonicalHeaderSet(hreq)
	canonicalRequest := strings.Join([]string{
		hreq.Method, canonicalURI, canonicalQuery, canonicalHeaders, signedNames, payloadHash,
	}, "\n")

	// --- cadena a firmar ---
	scope := strings.Join([]string{dateStamp, region, service, "aws4_request"}, "/")
	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256", amzDate, scope, hex.EncodeToString(sha256Sum([]byte(canonicalRequest))),
	}, "\n")

	// --- clave derivada, cuatro HMAC encadenados ---
	key := hmacSHA256([]byte("AWS4"+a.SecretKey), dateStamp)
	key = hmacSHA256(key, region)
	key = hmacSHA256(key, service)
	key = hmacSHA256(key, "aws4_request")
	signature := hex.EncodeToString(hmacSHA256(key, stringToSign))

	hreq.Header.Set("Authorization", fmt.Sprintf(
		"AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s",
		a.AccessKey, scope, signedNames, signature))
	return nil
}

// serviceFromHost saca el servicio del host de AWS. Devuelve "" cuando el
// host no tiene esa forma, y entonces el usuario lo escribe.
func serviceFromHost(host string) string {
	host = strings.Split(host, ":")[0]
	if !strings.HasSuffix(host, ".amazonaws.com") {
		return ""
	}
	parts := strings.Split(host, ".")
	if len(parts) < 3 {
		return ""
	}
	// `s3.amazonaws.com` o `execute-api.us-east-1.amazonaws.com`: el
	// servicio es el primer tramo en los dos casos.
	return parts[0]
}

// canonicalQueryString ordena por nombre y después por valor, y codifica con
// las reglas de AWS. El orden importa: el servidor recalcula la firma sobre
// esta misma cadena, así que una diferencia de orden es una firma inválida
// con un mensaje que no dice nada útil.
func canonicalQueryString(values url.Values) string {
	keys := make([]string, 0, len(values))
	for k := range values {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	var parts []string
	for _, k := range keys {
		vals := append([]string(nil), values[k]...)
		sort.Strings(vals)
		for _, v := range vals {
			parts = append(parts, awsEscape(k)+"="+awsEscape(v))
		}
	}
	return strings.Join(parts, "&")
}

// awsEscape aplica el escapado que pide SigV4, que NO es el de
// url.QueryEscape: el espacio va como %20 y no como "+", y la tilde queda
// literal. Dos diferencias chicas que invalidan la firma entera.
func awsEscape(s string) string {
	escaped := url.QueryEscape(s)
	escaped = strings.ReplaceAll(escaped, "+", "%20")
	escaped = strings.ReplaceAll(escaped, "%7E", "~")
	return escaped
}

// canonicalHeaderSet devuelve los nombres firmados y el bloque canónico.
func canonicalHeaderSet(hreq *http.Request) (signedNames, canonical string) {
	lower := map[string]string{}
	for name, values := range hreq.Header {
		key := strings.ToLower(name)
		// Los valores se colapsan a un espacio y se recortan, como pide la
		// especificación.
		joined := make([]string, len(values))
		for i, v := range values {
			joined[i] = strings.Join(strings.Fields(v), " ")
		}
		lower[key] = strings.Join(joined, ",")
	}
	// Host no está en el mapa de headers de Go: vive en req.Host.
	if hreq.Host != "" {
		lower["host"] = hreq.Host
	} else if hreq.URL != nil {
		lower["host"] = hreq.URL.Host
	}

	names := make([]string, 0, len(lower))
	for k := range lower {
		names = append(names, k)
	}
	sort.Strings(names)

	var b strings.Builder
	for _, n := range names {
		b.WriteString(n)
		b.WriteByte(':')
		b.WriteString(lower[n])
		b.WriteByte('\n')
	}
	return strings.Join(names, ";"), b.String()
}

func sha256Sum(b []byte) []byte {
	sum := sha256.Sum256(b)
	return sum[:]
}

func hmacSHA256(key []byte, data string) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(data))
	return mac.Sum(nil)
}

// --- Digest (RFC 7616) -------------------------------------------------------

// digestChallenge son los campos del WWW-Authenticate que manda el servidor.
type digestChallenge struct {
	realm, nonce, qop, opaque, algorithm string
}

// parseDigestChallenge lee el header de desafío. Devuelve ok=false si no es
// un desafío Digest, que es cómo se distingue "pide Digest" de "pide otra
// cosa" ante el mismo 401.
func parseDigestChallenge(header string) (digestChallenge, bool) {
	if !strings.HasPrefix(strings.ToLower(strings.TrimSpace(header)), "digest ") {
		return digestChallenge{}, false
	}
	var c digestChallenge
	rest := strings.TrimSpace(header[len("Digest "):])
	for _, part := range splitDigestParams(rest) {
		key, value, ok := strings.Cut(part, "=")
		if !ok {
			continue
		}
		key = strings.ToLower(strings.TrimSpace(key))
		value = strings.Trim(strings.TrimSpace(value), `"`)
		switch key {
		case "realm":
			c.realm = value
		case "nonce":
			c.nonce = value
		case "qop":
			c.qop = value
		case "opaque":
			c.opaque = value
		case "algorithm":
			c.algorithm = value
		}
	}
	return c, c.nonce != ""
}

// splitDigestParams parte por comas que NO estén dentro de comillas: un
// realm puede contener una coma, y partir a ciegas rompe el desafío.
func splitDigestParams(s string) []string {
	var parts []string
	var cur strings.Builder
	inQuotes := false
	for _, r := range s {
		switch {
		case r == '"':
			inQuotes = !inQuotes
			cur.WriteRune(r)
		case r == ',' && !inQuotes:
			parts = append(parts, cur.String())
			cur.Reset()
		default:
			cur.WriteRune(r)
		}
	}
	if cur.Len() > 0 {
		parts = append(parts, cur.String())
	}
	return parts
}

// digestAuthHeader calcula la respuesta al desafío.
func digestAuthHeader(a Auth, c digestChallenge, method, uri string) (string, error) {
	cnonce, err := randomHex(16)
	if err != nil {
		return "", err
	}
	// RFC 7616 agregó SHA-256; MD5 sigue siendo el default por
	// compatibilidad con los servidores que solo implementan la RFC 2617.
	algorithm := strings.ToUpper(c.algorithm)
	newHash := md5Hex
	if strings.HasPrefix(algorithm, "SHA-256") {
		newHash = sha256Hex
	}

	ha1 := newHash(a.Username + ":" + c.realm + ":" + a.Password)
	ha2 := newHash(method + ":" + uri)

	qop := ""
	for _, candidate := range strings.Split(c.qop, ",") {
		if strings.TrimSpace(candidate) == "auth" {
			qop = "auth"
			break
		}
	}

	var response string
	nc := "00000001"
	if qop == "auth" {
		response = newHash(strings.Join([]string{ha1, c.nonce, nc, cnonce, qop, ha2}, ":"))
	} else {
		response = newHash(strings.Join([]string{ha1, c.nonce, ha2}, ":"))
	}

	parts := []string{
		fmt.Sprintf(`username=%q`, a.Username),
		fmt.Sprintf(`realm=%q`, c.realm),
		fmt.Sprintf(`nonce=%q`, c.nonce),
		fmt.Sprintf(`uri=%q`, uri),
		fmt.Sprintf(`response=%q`, response),
	}
	if c.algorithm != "" {
		parts = append(parts, "algorithm="+c.algorithm)
	}
	if qop == "auth" {
		parts = append(parts, "qop=auth", "nc="+nc, fmt.Sprintf(`cnonce=%q`, cnonce))
	}
	if c.opaque != "" {
		parts = append(parts, fmt.Sprintf(`opaque=%q`, c.opaque))
	}
	return "Digest " + strings.Join(parts, ", "), nil
}

func md5Hex(s string) string {
	sum := md5.Sum([]byte(s))
	return hex.EncodeToString(sum[:])
}

func sha256Hex(s string) string {
	return hex.EncodeToString(sha256Sum([]byte(s)))
}

func randomHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
