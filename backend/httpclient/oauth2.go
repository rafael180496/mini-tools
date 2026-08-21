package httpclient

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// OAuth 2.0.
//
// # Los cuatro flujos y por qué el de código es distinto
//
// client_credentials, password y refresh_token son una sola petición POST al
// servidor de tokens: se arman acá y listo. authorization_code necesita al
// USUARIO —que abre el navegador, se autentica y autoriza—, así que hay que
// levantar un servidor local que reciba la redirección.
//
// # Por qué loopback y no un redirect_uri inventado
//
// Es lo que manda la RFC 8252 para aplicaciones nativas: un puerto efímero
// de 127.0.0.1. Las alternativas son peores — un esquema propio
// (`minitools://`) exige registrarlo en el sistema operativo, y pegar el
// código a mano obliga al usuario a hacer de intermediario en un intercambio
// que la app puede completar sola.
//
// **PKCE siempre**, incluso con client_secret. Sin PKCE, cualquier proceso
// local que escuche antes que nosotros en el puerto de la redirección puede
// robarse el código; con PKCE ese código no sirve sin el verificador, que
// nunca sale de este proceso.

// OAuth2Result es lo que devuelve el servidor de tokens, ya normalizado.
type OAuth2Result struct {
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken,omitempty"`
	TokenType    string `json:"tokenType,omitempty"`
	// ExpiresAt es el instante de vencimiento en Unix, no la duración: la
	// duración solo sirve en el momento de recibirla, y guardarla obligaría
	// a recordar además cuándo se recibió.
	ExpiresAt int64  `json:"expiresAt,omitempty"`
	Scope     string `json:"scope,omitempty"`
}

// TokenExpired reporta si hay que renovar. El margen de 30 segundos evita el
// caso clásico: un token que vence mientras la petición viaja, y una API que
// contesta 401 por dos segundos de diferencia.
func TokenExpired(expiresAt int64) bool {
	if expiresAt == 0 {
		return false
	}
	return time.Now().Add(30*time.Second).Unix() >= expiresAt
}

// FetchOAuth2Token pide un token con los flujos que no necesitan navegador.
func FetchOAuth2Token(ctx context.Context, a Auth) (*OAuth2Result, error) {
	if strings.TrimSpace(a.AccessTokenURL) == "" {
		return nil, errors.New("falta la URL del servidor de tokens")
	}

	form := url.Values{}
	grant := strings.TrimSpace(a.GrantType)
	if grant == "" {
		grant = "client_credentials"
	}
	form.Set("grant_type", grant)

	switch grant {
	case "client_credentials":
	case "password":
		if a.Username == "" {
			return nil, errors.New("el flujo password necesita usuario y contraseña")
		}
		form.Set("username", a.Username)
		form.Set("password", a.Password)
	case "refresh_token":
		if strings.TrimSpace(a.RefreshToken) == "" {
			return nil, errors.New("no hay refresh token guardado: pedí un token nuevo")
		}
		form.Set("refresh_token", a.RefreshToken)
	default:
		return nil, fmt.Errorf("flujo de OAuth 2.0 no soportado acá: %q", grant)
	}

	if a.Scope != "" {
		form.Set("scope", a.Scope)
	}
	return postTokenRequest(ctx, a, form)
}

// postTokenRequest manda la petición al servidor de tokens y normaliza la
// respuesta.
//
// Las credenciales del cliente van en el header Basic —que es lo que la RFC
// 6749 llama el método preferido y lo que esperan casi todos los
// servidores—, y NO en el cuerpo. Algunos servidores aceptan solo una de las
// dos formas; se elige la del estándar y, si falta el secreto (cliente
// público con PKCE), se manda el client_id en el cuerpo, que es lo que pide
// ese caso.
func postTokenRequest(ctx context.Context, a Auth, form url.Values) (*OAuth2Result, error) {
	if a.ClientSecret == "" && a.ClientID != "" {
		form.Set("client_id", a.ClientID)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.AccessTokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, fmt.Errorf("no se pudo armar la petición de token: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	if a.ClientSecret != "" {
		req.SetBasicAuth(url.QueryEscape(a.ClientID), url.QueryEscape(a.ClientSecret))
	}

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("no se pudo contactar al servidor de tokens: %w", err)
	}
	defer resp.Body.Close()

	var payload struct {
		AccessToken      string `json:"access_token"`
		RefreshToken     string `json:"refresh_token"`
		TokenType        string `json:"token_type"`
		ExpiresIn        int64  `json:"expires_in"`
		Scope            string `json:"scope"`
		Error            string `json:"error"`
		ErrorDescription string `json:"error_description"`
	}
	// Se lee el cuerpo aunque el status sea de error: el detalle del fallo
	// (`invalid_client`, `invalid_scope`) viene ahí, y sin él el usuario solo
	// ve "400" y no tiene por dónde empezar.
	body, _ := readAllLimited(resp.Body, 1<<20)
	_ = json.Unmarshal(body, &payload)

	if resp.StatusCode >= 400 || payload.Error != "" {
		detail := payload.ErrorDescription
		if detail == "" {
			detail = payload.Error
		}
		if detail == "" {
			detail = strings.TrimSpace(string(body))
		}
		return nil, fmt.Errorf("el servidor de tokens rechazó la petición (%d): %s", resp.StatusCode, detail)
	}
	if payload.AccessToken == "" {
		return nil, errors.New("el servidor contestó sin access_token")
	}

	out := &OAuth2Result{
		AccessToken:  payload.AccessToken,
		RefreshToken: payload.RefreshToken,
		TokenType:    payload.TokenType,
		Scope:        payload.Scope,
	}
	if payload.ExpiresIn > 0 {
		out.ExpiresAt = time.Now().Add(time.Duration(payload.ExpiresIn) * time.Second).Unix()
	}
	return out, nil
}

func readAllLimited(r interface{ Read([]byte) (int, error) }, max int64) ([]byte, error) {
	buf := make([]byte, 0, 4096)
	tmp := make([]byte, 4096)
	for int64(len(buf)) < max {
		n, err := r.Read(tmp)
		buf = append(buf, tmp[:n]...)
		if err != nil {
			return buf, nil
		}
	}
	return buf, nil
}

// AuthorizeOAuth2 completa el flujo de código de autorización: levanta el
// receptor en loopback, hace que el usuario autorice en el navegador y
// canjea el código por un token.
//
// openBrowser se recibe como parámetro en vez de llamarse desde acá para que
// esta función no dependa del runtime de Wails — y para poder ejercitarla
// sin abrir un navegador de verdad.
func AuthorizeOAuth2(ctx context.Context, a Auth, openBrowser func(string) error) (*OAuth2Result, error) {
	if strings.TrimSpace(a.AuthURL) == "" {
		return nil, errors.New("falta la URL de autorización")
	}
	if strings.TrimSpace(a.ClientID) == "" {
		return nil, errors.New("falta el Client ID")
	}

	// Puerto efímero de loopback: el sistema elige uno libre, que es lo que
	// evita chocar con otro proceso y lo que la RFC 8252 recomienda.
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("no se pudo abrir el receptor local de la redirección: %w", err)
	}
	defer listener.Close()

	redirect := a.RedirectURI
	if strings.TrimSpace(redirect) == "" {
		redirect = fmt.Sprintf("http://127.0.0.1:%d/callback", listener.Addr().(*net.TCPAddr).Port)
	}

	verifier, err := randomURLSafe(32)
	if err != nil {
		return nil, err
	}
	challenge := pkceChallenge(verifier)
	state, err := randomURLSafe(16)
	if err != nil {
		return nil, err
	}

	authURL, err := url.Parse(a.AuthURL)
	if err != nil {
		return nil, fmt.Errorf("la URL de autorización es inválida: %w", err)
	}
	q := authURL.Query()
	q.Set("response_type", "code")
	q.Set("client_id", a.ClientID)
	q.Set("redirect_uri", redirect)
	q.Set("state", state)
	q.Set("code_challenge", challenge)
	q.Set("code_challenge_method", "S256")
	if a.Scope != "" {
		q.Set("scope", a.Scope)
	}
	authURL.RawQuery = q.Encode()

	type callback struct {
		code string
		err  error
	}
	results := make(chan callback, 1)

	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		params := r.URL.Query()
		w.Header().Set("Content-Type", "text/html; charset=utf-8")

		if e := params.Get("error"); e != "" {
			detail := params.Get("error_description")
			if detail == "" {
				detail = e
			}
			fmt.Fprintf(w, callbackPage, "No se pudo autorizar", detail)
			results <- callback{err: fmt.Errorf("el servidor de autorización devolvió un error: %s", detail)}
			return
		}
		// El state se compara en tiempo constante y es obligatorio: sin esta
		// comprobación, otra página abierta en el navegador podría inyectar
		// su propio código en nuestra redirección.
		if subtle.ConstantTimeCompare([]byte(params.Get("state")), []byte(state)) != 1 {
			fmt.Fprintf(w, callbackPage, "Respuesta inesperada", "El parámetro de estado no coincide con el que envió la aplicación.")
			results <- callback{err: errors.New("el parámetro state no coincide: la respuesta no vino de la autorización que iniciamos")}
			return
		}
		code := params.Get("code")
		if code == "" {
			fmt.Fprintf(w, callbackPage, "Respuesta incompleta", "El servidor no envió ningún código de autorización.")
			results <- callback{err: errors.New("el servidor no devolvió un código de autorización")}
			return
		}
		fmt.Fprintf(w, callbackPage, "Listo", "Ya podés volver a mini-tools; esta pestaña se puede cerrar.")
		results <- callback{code: code}
	})}
	go srv.Serve(listener)
	defer srv.Close()

	if err := openBrowser(authURL.String()); err != nil {
		return nil, fmt.Errorf("no se pudo abrir el navegador: %w", err)
	}

	// El usuario tiene que autenticarse a mano: el tope es generoso, pero
	// existe para que la app no quede esperando para siempre si cierra la
	// pestaña sin autorizar.
	waitCtx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()

	var got callback
	select {
	case got = <-results:
	case <-waitCtx.Done():
		return nil, errors.New("se agotó la espera de la autorización en el navegador")
	}
	if got.err != nil {
		return nil, got.err
	}

	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("code", got.code)
	form.Set("redirect_uri", redirect)
	form.Set("code_verifier", verifier)
	return postTokenRequest(ctx, a, form)
}

// callbackPage es lo que ve el usuario en el navegador cuando vuelve. Sin
// estilos ni recursos externos: es una página servida desde un puerto
// efímero de loopback que vive dos segundos.
const callbackPage = `<!doctype html><html lang="es"><meta charset="utf-8">
<title>%[1]s</title>
<body style="font-family:system-ui,sans-serif;padding:3rem;max-width:32rem;margin:auto">
<h1 style="font-size:1.25rem">%[1]s</h1><p style="color:#555">%[2]s</p></body></html>`

func randomURLSafe(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("no se pudo generar un valor aleatorio: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// pkceChallenge es S256: el SHA-256 del verificador en base64url sin
// relleno. El método `plain` existe en la RFC pero no se ofrece — no protege
// de nada.
func pkceChallenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}
