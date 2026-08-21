package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"mini-tools/backend/httpclient"
	"mini-tools/backend/vault"
)

// Bindings del módulo de peticiones HTTP (F1 de
// .claude/specs/http-client.md).
//
// Mismos dos invariantes que el módulo Git: `requireUnlocked` primero sin
// excepción —una colección guarda cuerpos y documentación del usuario, que
// es dato gateado por la clave maestra— y el frontend direcciona todo por ID
// opaco.
//
// La capa de arriba (esta) traduce entre el texto JSON que persiste el vault
// y las estructuras tipadas de backend/httpclient. Esa frontera existe a
// propósito: el vault no tiene por qué saber qué es un header, y el motor no
// tiene por qué saber qué es una columna cifrada.

// --- Colecciones e ítems -----------------------------------------------------

func (a *App) HttpListCollections() ([]vault.HTTPCollection, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return a.vault.ListHTTPCollections()
}

func (a *App) HttpSaveCollection(c vault.HTTPCollection) (*vault.HTTPCollection, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return a.vault.SaveHTTPCollection(c)
}

// HttpDeleteCollection borra la colección con todo su árbol y su historial.
func (a *App) HttpDeleteCollection(id string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.DeleteHTTPCollection(id)
}

func (a *App) HttpListItems(collectionID string) ([]vault.HTTPItem, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return a.vault.ListHTTPItems(collectionID)
}

func (a *App) HttpGetItem(id string) (*vault.HTTPItem, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return a.vault.GetHTTPItem(id)
}

func (a *App) HttpSaveItem(it vault.HTTPItem) (*vault.HTTPItem, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return a.vault.SaveHTTPItem(it)
}

func (a *App) HttpDeleteItem(id string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.DeleteHTTPItem(id)
}

// HttpMoveItem reubica un ítem: nuevo padre (vacío = raíz de la colección) y
// posición entre sus hermanos.
func (a *App) HttpMoveItem(id, newParentID string, order int) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.MoveHTTPItem(id, newParentID, order)
}

// --- Variables y entornos ----------------------------------------------------

func (a *App) HttpListEnvironments() ([]vault.HTTPEnvironment, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return a.vault.ListHTTPEnvironments()
}

func (a *App) HttpSaveEnvironment(e vault.HTTPEnvironment) (*vault.HTTPEnvironment, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return a.vault.SaveHTTPEnvironment(e)
}

func (a *App) HttpDeleteEnvironment(id string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.DeleteHTTPEnvironment(id)
}

func (a *App) HttpActiveEnvironment() (string, error) {
	if err := a.requireUnlocked(); err != nil {
		return "", err
	}
	return a.vault.ActiveHTTPEnvironment()
}

func (a *App) HttpSetActiveEnvironment(id string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.SetActiveHTTPEnvironment(id)
}

// decodeVariables parsea una columna de variables. Igual que
// decodeKeyValues, un JSON roto se trata como lista vacía: una fila corrupta
// no puede impedir mandar la petición.
func decodeVariables(raw string) []httpclient.Variable {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	var out []httpclient.Variable
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return nil
	}
	return out
}

// varScopes arma la cadena de precedencia para un ítem.
//
// El orden es el de Postman —entorno ANTES que colección— y no al revés: una
// colección define el `HOST` por defecto y el entorno `dev` o `prod` lo pisa.
// Con la colección ganando, cambiar de entorno no haría nada, que es
// exactamente el bug que este orden evita.
//
// El entorno elegido es el ANCLADO a la colección si lo hay, y el activo si
// no. El anclaje gana porque es una decisión tomada sobre esa colección en
// particular; el activo es la preferencia general.
func (a *App) varScopes(collectionID string) []httpclient.VarScope {
	scopes, _ := a.scopesAndEnv(collectionID)
	return scopes
}

// scopesAndEnv devuelve además CUÁL entorno ganó.
//
// Hace falta porque el entorno elegido decide dos cosas, no una: qué valen las
// variables y **qué tarro de cookies se usa** (ver httpclient/jar.go). Un
// segundo recorrido para averiguar lo mismo sería la forma segura de que un día
// las variables salgan de un entorno y las cookies de otro.
func (a *App) scopesAndEnv(collectionID string) ([]httpclient.VarScope, string) {
	// Las dinámicas primero: {{$timestamp}} y {{$randomUUID}} le ganan a
	// cualquier variable del mismo nombre, porque no son configuración sino
	// el instante de ESTE envío. Se calculan una vez por llamada, así que
	// una firma sobre {{$timestamp}} usa el mismo valor que la URL.
	scopes := []httpclient.VarScope{httpclient.DynamicScope()}
	// Vacío es el tarro de "sin entorno", que también existe: una petición
	// suelta contra un login recibe su cookie y la manda en la siguiente.
	envID := ""

	envs, err := a.vault.ListHTTPEnvironments()
	if err == nil {
		activeID, _ := a.vault.ActiveHTTPEnvironment()
		var chosen *vault.HTTPEnvironment
		for i := range envs {
			if collectionID != "" && envs[i].PinnedCollectionID == collectionID {
				chosen = &envs[i]
				break
			}
			if envs[i].ID == activeID {
				chosen = &envs[i]
			}
		}
		if chosen != nil {
			envID = chosen.ID
			scopes = append(scopes, httpclient.VarScope{
				Label: "entorno «" + chosen.Name + "»",
				Vars:  decodeVariables(chosen.Variables),
			})
		}
	}

	if collectionID != "" {
		if cols, err := a.vault.ListHTTPCollections(); err == nil {
			for _, c := range cols {
				if c.ID == collectionID {
					scopes = append(scopes, httpclient.VarScope{
						Label: "colección «" + c.Name + "»",
						Vars:  decodeVariables(c.Variables),
					})
					break
				}
			}
		}
	}
	return scopes, envID
}

// computedScopes evalúa las variables derivadas del ítem y de su colección,
// y las antepone a la cadena.
//
// Van primero porque son el resultado de todo lo demás: una firma calculada
// sobre {{secreto}} tiene que poder usarse como {{sig}} en la URL, y si un
// entorno definiera una variable con ese nombre, la calculada es la que vale
// para este envío.
//
// Las de la colección se evalúan antes que las del ítem y en la misma tanda,
// así una puede encadenarse sobre la otra — que es cómo se arma una firma en
// dos pasos sin un lenguaje de por medio.
func (a *App) computedScopes(itemID, collectionID string, base []httpclient.VarScope) ([]httpclient.VarScope, []string) {
	var rows []httpclient.Computed

	if collectionID != "" {
		if cols, err := a.vault.ListHTTPCollections(); err == nil {
			for _, c := range cols {
				if c.ID == collectionID {
					rows = append(rows, decodeComputed(c.Computed)...)
					break
				}
			}
		}
	}
	if itemID != "" {
		if it, err := a.vault.GetHTTPItem(itemID); err == nil {
			rows = append(rows, decodeComputed(it.Computed)...)
		}
	}
	if len(rows) == 0 {
		return base, nil
	}

	scope, problems := httpclient.EvaluateComputed(rows, base)
	if len(scope.Vars) == 0 {
		return base, problems
	}
	return append([]httpclient.VarScope{scope}, base...), problems
}

func decodeComputed(raw string) []httpclient.Computed {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	var out []httpclient.Computed
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return nil
	}
	return out
}

// collectionOf devuelve la colección a la que pertenece un ítem, o "".
func (a *App) collectionOf(itemID string) string {
	if itemID == "" {
		return ""
	}
	it, err := a.vault.GetHTTPItem(itemID)
	if err != nil {
		return ""
	}
	return it.CollectionID
}

// HttpResolvePreview devuelve la petición con las variables ya sustituidas,
// más los nombres que faltan.
//
// Existe para que la UI pueda avisar ANTES de mandar: una `{{HOST}}` sin
// definir se marca en rojo en vez de producir un error de transporte que no
// nombra la causa. Los valores secretos vienen enmascarados: este resultado
// se muestra en pantalla, no se envía.
type HttpResolveResult struct {
	URL     string   `json:"url"`
	Missing []string `json:"missing"`
	// Scopes son las etiquetas de los niveles que participaron, en orden de
	// precedencia, para poder decir de dónde salió un valor.
	Scopes []string `json:"scopes"`
	// ComputedErrors son las variables derivadas que no se pudieron
	// calcular, con el motivo. Se reportan aparte de Missing porque son otro
	// problema: la variable existe, lo que falló es su cálculo.
	ComputedErrors []string `json:"computedErrors,omitempty"`
}

func (a *App) HttpResolvePreview(itemID string, req httpclient.Request) (*HttpResolveResult, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	collectionID := a.collectionOf(itemID)
	scopes, computedProblems := a.computedScopes(itemID, collectionID, a.varScopes(collectionID))
	resolved, summary := httpclient.ResolveRequest(req, scopes)

	out := &HttpResolveResult{Missing: summary.Missing, ComputedErrors: computedProblems}
	if url, err := httpclient.PreviewURL(resolved); err == nil {
		out.URL = httpclient.MaskSecrets(url, scopes)
	} else {
		out.URL = httpclient.MaskSecrets(resolved.URL, scopes)
	}
	for _, s := range scopes {
		out.Scopes = append(out.Scopes, s.Label)
	}
	return out, nil
}

// --- Ejecución ---------------------------------------------------------------

// HttpSendResult es lo que ve la UI: la respuesta, o el error ya explicado.
//
// El error viaja DENTRO del resultado en vez de como error de Go porque un
// 500 del servidor, un timeout y un certificado inválido son resultados
// normales de "probar un endpoint" — no fallas de la aplicación. Devolverlos
// como error dejaría a la UI sin la duración ni la petición que los produjo,
// que es justo lo que se quiere ver cuando algo falla.
type HttpSendResult struct {
	Response *httpclient.Response `json:"response,omitempty"`
	Error    string               `json:"error,omitempty"`
	// SentURL es la URL final que se armó (con path variables y query ya
	// aplicados). Se muestra siempre: la mitad de los problemas de una
	// petición se ven mirando la URL que realmente salió.
	SentURL    string `json:"sentUrl"`
	DurationMs int64  `json:"durationMs"`
	// Missing son las `{{variables}}` que no se pudieron resolver. Se
	// reportan aunque la petición haya salido: una URL con un `{{HOST}}`
	// literal adentro casi siempre explica el error que vino después.
	Missing []string `json:"missing,omitempty"`
	// ComputedErrors son las variables derivadas que fallaron al calcularse.
	ComputedErrors []string `json:"computedErrors,omitempty"`
}

// HttpSend ejecuta una petición.
//
// itemID puede venir vacío: una petición sin guardar también se puede
// mandar, y es como se prueba algo antes de decidir dónde ponerlo. Cuando
// viene, se usa para archivar la ejecución en el historial de ESE ítem.
//
// execID lo elige el frontend para poder cancelar; ver HttpCancel.
func (a *App) HttpSend(execID, itemID string, req httpclient.Request) (*HttpSendResult, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}

	// Las variables se resuelven ACÁ y no al guardar: lo persistido siempre
	// conserva el `{{HOST}}` literal, así que la misma petición sirve contra
	// dev y contra prod según el entorno elegido.
	collectionID := a.collectionOf(itemID)
	base, envID := a.scopesAndEnv(collectionID)
	scopes, computedProblems := a.computedScopes(itemID, collectionID, base)
	resolved, summary := httpclient.ResolveRequest(req, scopes)

	// La autenticación se resuelve por herencia y se agrega DESPUÉS de las
	// variables: un token guardado como `{{token}}` en la auth de la
	// colección tiene que resolverse igual que uno escrito en un header.
	auth, authLevel := a.authFor(itemID, req.Auth, scopes)
	resolved.Auth = a.refreshIfExpired(auth, authLevel)

	out := &HttpSendResult{Missing: summary.Missing, ComputedErrors: computedProblems}
	// Se calcula aparte de Send para poder mostrarla incluso cuando la
	// petición falla antes de salir. Enmascarada: se muestra en pantalla.
	out.SentURL = httpclient.MaskSecrets(a.previewURL(resolved), scopes)

	// El envío va con el tarro de cookies del entorno elegido: es lo que hace
	// que el login de una petición valga para la siguiente sin copiar la
	// cookie a mano, y lo que impide que probar prod y dev a la vez mezcle las
	// dos sesiones.
	resp, err := a.httpRunner.SendWithJar(execID, envID, resolved)
	if err != nil {
		out.Error = err.Error()
	} else {
		out.Response = resp
		out.DurationMs = resp.DurationMs
	}

	// El historial recibe la URL ya enmascarada Y además pasada por el
	// filtro de parámetros sospechosos: son dos capas distintas porque
	// atajan cosas distintas — una tapa los valores que vinieron de una
	// variable marcada secreta, la otra un `?token=` escrito a mano.
	entry := vault.HTTPHistoryEntry{
		ItemID: itemID,
		Method: strings.ToUpper(resolved.Method),
		URL:    redactURLForHistory(out.SentURL),
		Error:  out.Error,
	}
	if resp != nil {
		entry.Status = resp.Status
		entry.DurationMs = resp.DurationMs
		entry.SizeBytes = resp.SizeBytes
	}
	// Un fallo al archivar no puede tapar la respuesta que el usuario está
	// esperando: se ignora a propósito.
	_ = a.vault.AddHTTPHistory(entry)

	return out, nil
}

// authFor resuelve qué autenticación usa una petición.
//
// La de la propia petición gana si no dice "heredar"; si hereda, se sube por
// las carpetas y termina en la colección. Es la cadena de Postman, y es lo
// que hace que cambiar el token de una API sea UNA edición y no treinta.
//
// override permite mandar una petición sin guardar con la auth que hay en
// pantalla: si trae algo distinto de "heredar", se usa tal cual.
func (a *App) authFor(itemID string, override httpclient.Auth, scopes []httpclient.VarScope) (httpclient.Auth, *vault.HTTPAuthLevel) {
	if override.Type != "" && override.Type != httpclient.AuthInherit {
		// Una petición sin guardar: se usa lo que hay en pantalla y no hay
		// nivel donde escribir un token renovado.
		return httpclient.ResolveAuthVars(override, scopes), nil
	}
	if itemID == "" {
		return httpclient.Auth{Type: httpclient.AuthNone}, nil
	}

	levels, err := a.vault.HTTPAuthChain(itemID)
	if err != nil {
		return httpclient.Auth{Type: httpclient.AuthNone}, nil
	}

	// Se recorre buscando el primero que no herede, y se recuerda CUÁL fue:
	// un token de OAuth 2.0 renovado tiene que volver a ese mismo nivel.
	for i, level := range levels {
		parsed := decodeAuth(level.Auth)
		if parsed.Type == "" || parsed.Type == httpclient.AuthInherit {
			continue
		}
		// Las {{variables}} valen adentro de la autenticación: es donde más
		// sentido tiene guardar un secreto, porque así vive en el entorno
		// (cifrado, enmascarado, fuera del export) y no repetido en cada
		// petición.
		found := levels[i]
		return httpclient.ResolveAuthVars(parsed, scopes), &found
	}
	return httpclient.Auth{Type: httpclient.AuthNone}, nil
}

// refreshIfExpired renueva un token de OAuth 2.0 vencido antes de mandar la
// petición, y lo guarda en el nivel donde estaba configurada la
// autenticación.
//
// Sin esto, un token con una hora de vida convierte el módulo en "andá a la
// pestaña Auth y apretá Obtener token" cada hora — que es exactamente el
// trabajo manual que la autenticación guardada existe para evitar. Solo
// aplica si hay refresh token: sin él no hay forma de renovar sin volver a
// pasar por el navegador, y hacerlo en silencio sería abrirlo de sorpresa.
func (a *App) refreshIfExpired(auth httpclient.Auth, level *vault.HTTPAuthLevel) httpclient.Auth {
	if auth.Type != httpclient.AuthOAuth2 || auth.RefreshToken == "" {
		return auth
	}
	if auth.AccessToken != "" && !httpclient.TokenExpired(auth.ExpiresAt) {
		return auth
	}

	renew := auth
	renew.GrantType = "refresh_token"
	res, err := httpclient.FetchOAuth2Token(a.ctx, renew)
	if err != nil {
		// Falla la renovación: se manda con lo que hay. El servidor va a
		// contestar 401 y ese error, con su cuerpo, es más útil que uno
		// nuestro diciendo "no pude renovar" sin la respuesta real.
		return auth
	}

	auth.AccessToken = res.AccessToken
	auth.ExpiresAt = res.ExpiresAt
	if res.RefreshToken != "" {
		// Algunos servidores rotan el refresh token en cada uso: quedarse
		// con el viejo haría que la siguiente renovación fallara.
		auth.RefreshToken = res.RefreshToken
	}

	if level != nil {
		stored := decodeAuth(level.Auth)
		stored.AccessToken = auth.AccessToken
		stored.ExpiresAt = auth.ExpiresAt
		if res.RefreshToken != "" {
			stored.RefreshToken = auth.RefreshToken
		}
		if encoded, err := json.Marshal(stored); err == nil {
			_ = a.vault.SaveHTTPAuthAt(*level, string(encoded))
		}
	}
	return auth
}

// decodeAuth parsea una columna de auth. Un JSON roto se trata como
// "heredar" en vez de como error: una configuración corrupta en un nivel no
// puede impedir que la petición use la del nivel de arriba.
func decodeAuth(raw string) httpclient.Auth {
	if strings.TrimSpace(raw) == "" {
		return httpclient.Auth{Type: httpclient.AuthInherit}
	}
	var out httpclient.Auth
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return httpclient.Auth{Type: httpclient.AuthInherit}
	}
	return out
}

// HttpAuthPreview dice qué autenticación va a usar una petición y de dónde
// sale, sin mandar nada.
//
// Con herencia, "qué credencial estoy mandando" deja de ser obvio: la
// respuesta puede estar tres niveles más arriba. Mostrarla es la diferencia
// entre entender un 401 y adivinarlo.
type HttpAuthPreviewResult struct {
	Type string `json:"type"`
	// Executable es false para los tipos que se guardan y se exportan pero
	// todavía no se firman (OAuth 1.0, NTLM, Hawk…).
	Executable bool `json:"executable"`
	// NeedsToken marca un OAuth 2.0 sin token vigente: la UI ofrece pedirlo.
	NeedsToken bool `json:"needsToken"`
}

func (a *App) HttpAuthPreview(itemID string, override httpclient.Auth) (*HttpAuthPreviewResult, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	collectionID := a.collectionOf(itemID)
	scopes, _ := a.computedScopes(itemID, collectionID, a.varScopes(collectionID))
	resolved, _ := a.authFor(itemID, override, scopes)
	return &HttpAuthPreviewResult{
		Type:       resolved.Type,
		Executable: resolved.Executable(),
		NeedsToken: resolved.Type == httpclient.AuthOAuth2 &&
			(resolved.AccessToken == "" || httpclient.TokenExpired(resolved.ExpiresAt)),
	}, nil
}

// HttpFetchOAuth2Token pide un token con los flujos que no necesitan
// navegador (client credentials, password, refresh token).
//
// Devuelve el token en vez de guardarlo: quién lo persiste es la UI, que
// sabe en qué nivel de la herencia está configurada la autenticación. Que
// esta función eligiera el nivel sería adivinar.
func (a *App) HttpFetchOAuth2Token(auth httpclient.Auth) (*httpclient.OAuth2Result, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return httpclient.FetchOAuth2Token(a.ctx, auth)
}

// HttpAuthorizeOAuth2 completa el flujo de código de autorización: abre el
// navegador del sistema y espera la redirección en un puerto de loopback
// (RFC 8252), con PKCE S256.
func (a *App) HttpAuthorizeOAuth2(auth httpclient.Auth) (*httpclient.OAuth2Result, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return httpclient.AuthorizeOAuth2(a.ctx, auth, func(target string) error {
		runtime.BrowserOpenURL(a.ctx, target)
		return nil
	})
}

// HttpCancel aborta una petición en vuelo. Cancelar algo que ya terminó no
// es un error.
func (a *App) HttpCancel(execID string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	a.httpRunner.Cancel(execID)
	return nil
}

func (a *App) HttpHistory(itemID string) ([]vault.HTTPHistoryEntry, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return a.vault.ListHTTPHistory(itemID)
}

func (a *App) HttpClearHistory(itemID string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.ClearHTTPHistory(itemID)
}

// HttpPickFile abre el selector de archivos para un campo de tipo archivo
// (form-data o cuerpo binario). Devuelve "" si el usuario cancela, que no es
// un error.
func (a *App) HttpPickFile(title string) (string, error) {
	if err := a.requireUnlocked(); err != nil {
		return "", err
	}
	path, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{Title: title})
	if err != nil {
		return "", fmt.Errorf("app: abriendo el selector de archivos: %w", err)
	}
	return path, nil
}

// HttpSaveResponseToFile guarda el cuerpo de una respuesta en el disco.
//
// Recibe las tres formas en las que puede venir un cuerpo —texto en memoria,
// binario en base64, o la ruta del volcado cuando era demasiado grande— y
// elige la correcta. Sin el tercer caso, guardar una descarga de 200 MB
// habría escrito los primeros 8: un archivo corrupto con nombre bueno, que
// es peor que no ofrecer el botón.
func (a *App) HttpSaveResponseToFile(spillPath, base64Body, textBody, suggestedName string) (string, error) {
	if err := a.requireUnlocked(); err != nil {
		return "", err
	}
	if suggestedName == "" {
		suggestedName = "respuesta.bin"
	}

	dest, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           "Guardar la respuesta",
		DefaultFilename: suggestedName,
	})
	if err != nil {
		return "", fmt.Errorf("app: abriendo diálogo de guardado: %w", err)
	}
	if dest == "" {
		return "", nil
	}

	switch {
	case spillPath != "":
		// Se copia en streaming: el volcado existe justamente porque el
		// cuerpo no entraba en memoria, así que leerlo entero acá anularía
		// el motivo de haberlo volcado.
		src, err := os.Open(spillPath)
		if err != nil {
			return "", fmt.Errorf("no se pudo leer la respuesta guardada: %w", err)
		}
		defer src.Close()
		out, err := os.Create(dest)
		if err != nil {
			return "", fmt.Errorf("no se pudo crear %q: %w", dest, err)
		}
		defer out.Close()
		if _, err := io.Copy(out, src); err != nil {
			return "", fmt.Errorf("escribiendo %q: %w", dest, err)
		}
	case base64Body != "":
		raw, err := base64.StdEncoding.DecodeString(base64Body)
		if err != nil {
			return "", fmt.Errorf("la respuesta binaria está corrupta: %w", err)
		}
		if err := os.WriteFile(dest, raw, 0o644); err != nil {
			return "", fmt.Errorf("escribiendo %q: %w", dest, err)
		}
	default:
		if err := os.WriteFile(dest, []byte(textBody), 0o644); err != nil {
			return "", fmt.Errorf("escribiendo %q: %w", dest, err)
		}
	}
	return dest, nil
}

// --- Interop: Postman, cURL, snippets ----------------------------------------

// HttpImportResult resume qué entró, para poder decirlo en vez de dejar al
// usuario contando peticiones en el árbol.
type HttpImportResult struct {
	CollectionID string `json:"collectionId"`
	Name         string `json:"name"`
	Requests     int    `json:"requests"`
	Folders      int    `json:"folders"`
	// Warnings son cosas que se importaron pero no se van a ejecutar: una
	// autenticación que no firmamos, un archivo cuya ruta no vino en el
	// export. Se dicen al terminar, no se descubren al mandar.
	Warnings []string `json:"warnings,omitempty"`
}

// HttpImportPostman abre un archivo de colección exportado de Postman y lo
// trae completo.
func (a *App) HttpImportPostman() (*HttpImportResult, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}

	path, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title:   "Elegir una colección exportada de Postman",
		Filters: []runtime.FileFilter{{DisplayName: "Colección de Postman (*.json)", Pattern: "*.json"}},
	})
	if err != nil {
		return nil, fmt.Errorf("app: abriendo el selector: %w", err)
	}
	if path == "" {
		return nil, nil
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("no se pudo leer %q: %w", path, err)
	}
	parsed, err := httpclient.ParsePostman(data)
	if err != nil {
		return nil, err
	}

	col, err := a.vault.SaveHTTPCollection(vault.HTTPCollection{
		Name:        parsed.Name,
		Description: parsed.Description,
		Variables:   marshalOrEmpty(parsed.Variables),
		Auth:        marshalAuth(parsed.Auth),
		PreRequest:  parsed.PreRequest,
		TestScript:  parsed.TestScript,
	})
	if err != nil {
		return nil, err
	}
	// El crudo de la colección va en su propia escritura para no ensanchar
	// la firma de SaveHTTPCollection con un campo que solo usa el import.
	if parsed.Raw != "" {
		_ = a.vault.SaveHTTPCollectionRaw(col.ID, parsed.Raw)
	}

	out := &HttpImportResult{CollectionID: col.ID, Name: col.Name, Warnings: parsed.Warnings}
	if err := a.importItems(col.ID, "", parsed.Items, out); err != nil {
		// La colección a medias se borra: media colección importada es peor
		// que ninguna, porque parece completa.
		_ = a.vault.DeleteHTTPCollection(col.ID)
		return nil, err
	}
	return out, nil
}

func (a *App) importItems(collectionID, parentID string, items []httpclient.ImportedItem, out *HttpImportResult) error {
	for _, it := range items {
		saved, err := a.vault.SaveHTTPItem(vault.HTTPItem{
			CollectionID: collectionID,
			ParentID:     parentID,
			Kind:         it.Kind,
			Name:         it.Name,
			Method:       it.Method,
			URL:          it.URL,
			Params:       marshalOrEmpty(it.Params),
			PathVars:     marshalOrEmpty(it.PathVars),
			Headers:      marshalOrEmpty(it.Headers),
			Body:         marshalBody(it.Body),
			Auth:         marshalAuth(it.Auth),
			Docs:         it.Docs,
			PreRequest:   it.PreRequest,
			TestScript:   it.TestScript,
		})
		if err != nil {
			return err
		}
		if it.Raw != "" {
			_ = a.vault.SaveHTTPItemRaw(saved.ID, it.Raw)
		}
		if it.Kind == "folder" {
			out.Folders++
			if err := a.importItems(collectionID, saved.ID, it.Children, out); err != nil {
				return err
			}
			continue
		}
		out.Requests++
	}
	return nil
}

// HttpExportPostman escribe la colección como un archivo de Postman.
func (a *App) HttpExportPostman(collectionID string) (string, error) {
	if err := a.requireUnlocked(); err != nil {
		return "", err
	}

	cols, err := a.vault.ListHTTPCollections()
	if err != nil {
		return "", err
	}
	var col *vault.HTTPCollection
	for i := range cols {
		if cols[i].ID == collectionID {
			col = &cols[i]
			break
		}
	}
	if col == nil {
		return "", fmt.Errorf("no existe la colección %q", collectionID)
	}

	items, err := a.vault.ListHTTPItems(collectionID)
	if err != nil {
		return "", err
	}
	raw, err := a.vault.HTTPCollectionRaw(collectionID)
	if err != nil {
		raw = ""
	}

	doc := httpclient.ImportedCollection{
		Name:        col.Name,
		Description: col.Description,
		Variables:   decodeVariables(col.Variables),
		Auth:        decodeAuth(col.Auth),
		PreRequest:  col.PreRequest,
		TestScript:  col.TestScript,
		Raw:         raw,
		Items:       a.exportTree(items, ""),
	}
	encoded, err := httpclient.BuildPostman(doc)
	if err != nil {
		return "", err
	}

	dest, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           "Exportar la colección",
		DefaultFilename: safeFilename(col.Name) + ".postman_collection.json",
		Filters:         []runtime.FileFilter{{DisplayName: "Colección de Postman (*.json)", Pattern: "*.json"}},
	})
	if err != nil {
		return "", fmt.Errorf("app: abriendo diálogo de guardado: %w", err)
	}
	if dest == "" {
		return "", nil
	}
	if err := os.WriteFile(dest, encoded, 0o644); err != nil {
		return "", fmt.Errorf("escribiendo %q: %w", dest, err)
	}
	return dest, nil
}

func (a *App) exportTree(items []vault.HTTPItem, parentID string) []httpclient.ImportedItem {
	var out []httpclient.ImportedItem
	for _, it := range items {
		if it.ParentID != parentID {
			continue
		}
		raw, _ := a.vault.HTTPItemRaw(it.ID)
		node := httpclient.ImportedItem{
			Kind: it.Kind, Name: it.Name, Method: it.Method, URL: it.URL,
			Params: decodeKeyValues(it.Params), PathVars: decodeKeyValues(it.PathVars),
			Headers: decodeKeyValues(it.Headers), Auth: decodeAuth(it.Auth),
			Docs: it.Docs, PreRequest: it.PreRequest, TestScript: it.TestScript, Raw: raw,
		}
		if strings.TrimSpace(it.Body) != "" {
			_ = json.Unmarshal([]byte(it.Body), &node.Body)
		}
		if it.Kind == "folder" {
			node.Children = a.exportTree(items, it.ID)
		}
		out = append(out, node)
	}
	return out
}

// HttpImportCurl traduce un comando cURL pegado a una petición editable.
func (a *App) HttpImportCurl(command string) (*httpclient.Request, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	req, err := httpclient.ParseCurl(command)
	if err != nil {
		return nil, err
	}
	return &req, nil
}

// HttpCodeLanguages son los lenguajes ofrecidos para el snippet.
func (a *App) HttpCodeLanguages() []httpclient.CodeLanguage {
	return httpclient.CodeLanguages()
}

// HttpGenerateCode escribe la petición en el lenguaje pedido.
//
// Se genera desde la petición YA RESUELTA (variables sustituidas), porque un
// snippet con `{{HOST}}` adentro no sirve para pegarlo en ningún lado.
// withSecrets decide si los valores que vinieron de variables secretas salen
// tal cual o enmascarados: el uso típico es pegarlo en un ticket o un chat,
// y ahí un token real es una filtración.
func (a *App) HttpGenerateCode(itemID string, req httpclient.Request, lang string, withSecrets bool) (string, error) {
	if err := a.requireUnlocked(); err != nil {
		return "", err
	}
	collectionID := a.collectionOf(itemID)
	scopes, _ := a.computedScopes(itemID, collectionID, a.varScopes(collectionID))
	resolved, _ := httpclient.ResolveRequest(req, scopes)

	auth, _ := a.authFor(itemID, req.Auth, scopes)
	resolved.Auth = auth
	// La autenticación se vuelca a headers para que el snippet la incluya:
	// un fetch sin el Authorization que la aplicación sí manda es un snippet
	// que no reproduce la petición.
	resolved.Headers = append(resolved.Headers, httpclient.AuthAsHeaders(auth)...)

	code, err := httpclient.GenerateCode(resolved, lang)
	if err != nil {
		return "", err
	}
	if !withSecrets {
		code = httpclient.MaskSecrets(code, scopes)
	}
	return code, nil
}

// safeFilename saca de un nombre lo que no puede ir en un archivo.
func safeFilename(name string) string {
	replacer := strings.NewReplacer("/", "-", "\\", "-", ":", "-", "*", "-", "?", "-", "\"", "-", "<", "-", ">", "-", "|", "-")
	out := strings.TrimSpace(replacer.Replace(name))
	if out == "" {
		return "coleccion"
	}
	return out
}

func marshalOrEmpty(v any) string {
	if v == nil {
		return ""
	}
	b, err := json.Marshal(v)
	if err != nil || string(b) == "null" || string(b) == "[]" {
		return ""
	}
	return string(b)
}

func marshalAuth(a httpclient.Auth) string {
	if a.Type == "" || a.Type == httpclient.AuthInherit {
		return ""
	}
	return marshalOrEmpty(a)
}

func marshalBody(b httpclient.Body) string {
	if b.Mode == "" || b.Mode == httpclient.BodyNone {
		return ""
	}
	return marshalOrEmpty(b)
}

// --- Utilidades --------------------------------------------------------------

// HttpFormatBody indenta un cuerpo JSON o XML.
//
// Devuelve el texto tal cual —sin error— cuando no parsea: el caso normal de
// apretar "formatear" es un JSON a medio escribir, y vaciar el editor por
// eso sería castigar el flujo de trabajo real.
func (a *App) HttpFormatBody(lang, text string) (string, error) {
	if err := a.requireUnlocked(); err != nil {
		return "", err
	}
	out, _ := httpclient.FormatBody(lang, text)
	return out, nil
}

// HttpDefaultSettings son los settings de una petición nueva. Vive en Go
// para que el default de "verificar TLS" tenga una sola definición: si el
// frontend armara el suyo, dos lugares tendrían que acordarse de que ese
// campo nace en true.
func (a *App) HttpDefaultSettings() httpclient.Settings {
	return httpclient.DefaultSettings()
}

// previewURL arma la URL final sin ejecutar nada, para mostrarla junto al
// resultado. Un error acá no es fatal: se devuelve la URL cruda, que es
// mejor que nada.
func (a *App) previewURL(req httpclient.Request) string {
	preview, err := httpclient.PreviewURL(req)
	if err != nil {
		return req.URL
	}
	return preview
}

// redactURLForHistory saca de la URL lo que parezca un secreto antes de
// archivarla.
//
// El historial es persistente y se lee semanas después; una URL con
// `?token=...` o `?api_key=...` lo convertiría en un archivo de credenciales
// con fecha. Es el mismo criterio que el filtro de secretos del historial de
// SSH: no pretende ser exhaustivo, cubre lo que aparece de verdad.
func redactURLForHistory(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.RawQuery == "" {
		return raw
	}
	q := u.Query()
	changed := false
	for key := range q {
		lower := strings.ToLower(key)
		for _, needle := range []string{"token", "secret", "password", "passwd", "api_key", "apikey", "access_key", "auth", "signature", "sig"} {
			if strings.Contains(lower, needle) {
				q.Set(key, "***")
				changed = true
				break
			}
		}
	}
	if !changed {
		return raw
	}
	u.RawQuery = q.Encode()
	return u.String()
}

// decodeKeyValues parsea una de las columnas de texto JSON del vault
// (params, headers, pathVars). Un JSON roto se trata como lista vacía en vez
// de como error: una fila corrupta no puede impedir abrir la petición.
func decodeKeyValues(raw string) []httpclient.KeyValue {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	var out []httpclient.KeyValue
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return nil
	}
	return out
}

// HttpBuildRequest arma la petición ejecutable a partir de un ítem guardado.
//
// Existe como binding —y no como armado en el frontend— porque es el punto
// donde en F2 se van a resolver las variables y en F4 la autenticación
// heredada. Que la UI llame a "armá la petición de este ítem" desde ahora
// significa que esas fases no tienen que cambiar el frontend.
func (a *App) HttpBuildRequest(itemID string) (*httpclient.Request, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	it, err := a.vault.GetHTTPItem(itemID)
	if err != nil {
		return nil, err
	}
	if it.Kind != "request" {
		return nil, fmt.Errorf("%q es una carpeta, no una petición", it.Name)
	}

	req := httpclient.Request{
		Method:   it.Method,
		URL:      it.URL,
		Params:   decodeKeyValues(it.Params),
		PathVars: decodeKeyValues(it.PathVars),
		Headers:  decodeKeyValues(it.Headers),
		Settings: httpclient.DefaultSettings(),
	}
	if strings.TrimSpace(it.Body) != "" {
		_ = json.Unmarshal([]byte(it.Body), &req.Body)
	}
	if strings.TrimSpace(it.Settings) != "" {
		_ = json.Unmarshal([]byte(it.Settings), &req.Settings)
	}
	return &req, nil
}
