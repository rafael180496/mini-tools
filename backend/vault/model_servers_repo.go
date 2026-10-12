package vault

import (
	"database/sql"
	"encoding/json"
	"net/url"
	"sort"
	"strings"
	"time"

	mtcrypto "mini-tools/backend/crypto"
	"mini-tools/backend/i18n"
)

// Servidores de modelos (migración 57): Ollama y cualquier servidor
// compatible con la API de OpenAI, locales o remotos.
//
// Cada uno aparece en el catálogo de agentes con el id `llm:<id>`. El token
// (Bearer, opcional) va cifrado por columna con la clave maestra y **nunca
// cruza hacia el frontend**: solo viaja si existe (HasToken), misma regla que
// la API key de un agente.

// Tipos de servidor que se aceptan.
const (
	ModelServerOllama = "ollama"
	ModelServerOpenAI = "openai"
)

// ModelServer es un servidor de modelos guardado. No lleva el token ni los
// valores de las cabeceras: solo sus NOMBRES (HeaderNames), que no son
// secretos y alcanzan para mostrar qué hay configurado.
type ModelServer struct {
	ID       string
	Name     string
	Kind     string
	BaseURL  string
	HasToken bool
	// InsecureTLS: no verificar el certificado de este servidor (certificado
	// propio o autofirmado). Preferencia en claro, apagada por defecto.
	InsecureTLS bool
	// ContextTokens: ventana de contexto (en tokens) que se le pide a un
	// servidor Ollama como options.num_ctx. 0 = la que traiga el servidor.
	// Un servidor compatible con OpenAI la decide al cargar el modelo y no
	// admite pedirla por petición.
	ContextTokens int
	HeaderNames   []string
	CreatedAt     int64
	UpdatedAt     int64
}

const modelServerColumns = `id, name, kind, base_url, encrypted_token IS NOT NULL, insecure_tls, context_tokens, encrypted_headers, headers_nonce, created_at, updated_at`

// scanModelServer lee una fila. Los nombres de las cabeceras salen de
// descifrar el JSON guardado; si eso falla (clave distinta, fila dañada) se
// devuelven vacíos en lugar de romper el listado entero: la fila se sigue
// pudiendo abrir y corregir, y los valores nunca se muestran de todos modos.
func (s *Store) scanModelServer(sc interface{ Scan(...any) error }) (ModelServer, error) {
	var m ModelServer
	var encH, nonceH []byte
	err := sc.Scan(&m.ID, &m.Name, &m.Kind, &m.BaseURL, &m.HasToken, &m.InsecureTLS, &m.ContextTokens, &encH, &nonceH, &m.CreatedAt, &m.UpdatedAt)
	if err != nil {
		return m, err
	}
	m.HeaderNames = []string{}
	if h, err := s.decryptHeaders(encH, nonceH); err == nil {
		m.HeaderNames = sortedHeaderNames(h)
	}
	return m, nil
}

func sortedHeaderNames(h map[string]string) []string {
	names := make([]string, 0, len(h))
	for k := range h {
		names = append(names, k)
	}
	sort.Slice(names, func(i, j int) bool { return strings.ToLower(names[i]) < strings.ToLower(names[j]) })
	return names
}

// decryptHeaders descifra el JSON {nombre: valor}. Sin datos devuelve nil.
func (s *Store) decryptHeaders(enc, nonce []byte) (map[string]string, error) {
	if len(enc) == 0 || len(nonce) == 0 {
		return nil, nil
	}
	key, err := s.gate.Key()
	if err != nil {
		return nil, err
	}
	plain, err := mtcrypto.Decrypt(key, enc, nonce)
	if err != nil {
		return nil, i18n.Errorf(i18n.Msg{ES: "vault: descifrando las cabeceras del servidor: %w", EN: "vault: decrypting the server headers: %w"}, err)
	}
	var h map[string]string
	if err := json.Unmarshal(plain, &h); err != nil {
		return nil, i18n.Errorf(i18n.Msg{ES: "vault: leyendo las cabeceras del servidor: %w", EN: "vault: reading the server headers: %w"}, err)
	}
	return h, nil
}

// ModelServerHeaders devuelve las cabeceras guardadas (nombre → valor), o nil
// si no hay. Sin binding: solo App la usa, para armar el cliente HTTP.
func (s *Store) ModelServerHeaders(id string) (map[string]string, error) {
	var enc, nonce []byte
	err := s.db.QueryRow(`SELECT encrypted_headers, headers_nonce FROM model_servers WHERE id = ?`, id).Scan(&enc, &nonce)
	if err == sql.ErrNoRows {
		return nil, i18n.Errorf(i18n.Msg{ES: "vault: el servidor de modelos no existe", EN: "vault: the model server does not exist"})
	}
	if err != nil {
		return nil, i18n.Errorf(i18n.Msg{ES: "vault: leyendo las cabeceras del servidor: %w", EN: "vault: reading the server headers: %w"}, err)
	}
	return s.decryptHeaders(enc, nonce)
}

// ListModelServers devuelve los servidores guardados, por nombre.
func (s *Store) ListModelServers() ([]ModelServer, error) {
	rows, err := s.db.Query(`SELECT ` + modelServerColumns + ` FROM model_servers ORDER BY name COLLATE NOCASE`)
	if err != nil {
		return nil, i18n.Errorf(i18n.Msg{ES: "vault: listando los servidores de modelos: %w", EN: "vault: listing the model servers: %w"}, err)
	}
	defer rows.Close()

	out := []ModelServer{}
	for rows.Next() {
		m, err := s.scanModelServer(rows)
		if err != nil {
			return nil, i18n.Errorf(i18n.Msg{ES: "vault: leyendo un servidor de modelos: %w", EN: "vault: reading a model server: %w"}, err)
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// GetModelServer devuelve un servidor por id.
func (s *Store) GetModelServer(id string) (ModelServer, error) {
	m, err := s.scanModelServer(s.db.QueryRow(`SELECT `+modelServerColumns+` FROM model_servers WHERE id = ?`, id))
	if err == sql.ErrNoRows {
		return ModelServer{}, i18n.Errorf(i18n.Msg{ES: "vault: el servidor de modelos no existe", EN: "vault: the model server does not exist"})
	}
	if err != nil {
		return ModelServer{}, i18n.Errorf(i18n.Msg{ES: "vault: leyendo el servidor de modelos: %w", EN: "vault: reading the model server: %w"}, err)
	}
	return m, nil
}

// ValidateModelServer comprueba el tipo y la URL y devuelve la URL ya limpia
// (sin espacios ni barra final).
func ValidateModelServer(kind, baseURL string) (string, error) {
	if kind != ModelServerOllama && kind != ModelServerOpenAI {
		return "", i18n.Errorf(i18n.Msg{ES: "vault: tipo de servidor desconocido %q (usá ollama u openai)", EN: "vault: unknown server kind %q (use ollama or openai)"}, kind)
	}
	baseURL = strings.TrimSpace(baseURL)
	u, err := url.Parse(baseURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", i18n.Errorf(i18n.Msg{ES: "vault: la URL del servidor tiene que ser http:// o https:// con un host", EN: "vault: the server URL must be http:// or https:// with a host"})
	}
	return strings.TrimRight(baseURL, "/"), nil
}

// SaveModelServer crea (id vacío) o actualiza un servidor.
//
// token vacío conserva el guardado; clearToken lo borra. Un token no vacío lo
// reemplaza aunque venga clearToken: pedir las dos cosas a la vez no tiene otra
// lectura razonable que "ponelo".
//
// replaceHeaders=false conserva las cabeceras guardadas (headers se ignora);
// true las reemplaza por headers, y un mapa vacío las borra todas. Se validan
// contra el token que va a quedar: ver ValidateModelServerHeaders.
// in.InsecureTLS se guarda tal cual.
func (s *Store) SaveModelServer(in ModelServer, token string, clearToken bool, headers map[string]string, replaceHeaders bool) (ModelServer, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return ModelServer{}, i18n.Errorf(i18n.Msg{ES: "vault: el servidor necesita un nombre", EN: "vault: the server needs a name"})
	}
	baseURL, err := ValidateModelServer(in.Kind, in.BaseURL)
	if err != nil {
		return ModelServer{}, err
	}
	token = strings.TrimSpace(token)

	var taken string
	switch err := s.db.QueryRow(`SELECT id FROM model_servers WHERE name = ? AND id <> ?`, name, in.ID).Scan(&taken); err {
	case nil:
		return ModelServer{}, i18n.Errorf(i18n.Msg{ES: "vault: ya hay un servidor de modelos llamado %q", EN: "vault: there is already a model server named %q"}, name)
	case sql.ErrNoRows:
	default:
		return ModelServer{}, i18n.Errorf(i18n.Msg{ES: "vault: comprobando el nombre del servidor: %w", EN: "vault: checking the server name: %w"}, err)
	}

	// Qué token y qué cabeceras van a quedar, para validarlas juntas.
	tokenSet := token != ""
	finalHeaders := headers
	if in.ID != "" {
		cur, err := s.GetModelServer(in.ID)
		if err != nil {
			return ModelServer{}, err
		}
		if token == "" {
			tokenSet = cur.HasToken && !clearToken
		}
		if !replaceHeaders {
			if finalHeaders, err = s.ModelServerHeaders(in.ID); err != nil {
				return ModelServer{}, err
			}
		}
	} else if !replaceHeaders {
		finalHeaders = nil
	}
	finalHeaders, err = ValidateModelServerHeaders(finalHeaders, tokenSet)
	if err != nil {
		return ModelServer{}, err
	}

	var key []byte
	needKey := func() error {
		if key != nil {
			return nil
		}
		k, err := s.gate.Key()
		if err != nil {
			return err
		}
		key = k
		return nil
	}

	var enc, nonce []byte
	if token != "" {
		if err := needKey(); err != nil {
			return ModelServer{}, err
		}
		enc, nonce, err = mtcrypto.Encrypt(key, []byte(token))
		if err != nil {
			return ModelServer{}, i18n.Errorf(i18n.Msg{ES: "vault: cifrando el token del servidor: %w", EN: "vault: encrypting the server token: %w"}, err)
		}
	}

	// Las cabeceras solo se reescriben si se pidió; un mapa vacío las borra
	// (NULL), no guarda un "{}" cifrado.
	var encH, nonceH []byte
	if replaceHeaders && len(finalHeaders) > 0 {
		if err := needKey(); err != nil {
			return ModelServer{}, err
		}
		raw, err := json.Marshal(finalHeaders)
		if err != nil {
			return ModelServer{}, err
		}
		encH, nonceH, err = mtcrypto.Encrypt(key, raw)
		if err != nil {
			return ModelServer{}, i18n.Errorf(i18n.Msg{ES: "vault: cifrando las cabeceras del servidor: %w", EN: "vault: encrypting the server headers: %w"}, err)
		}
	}

	// Solo Ollama la admite; en un servidor OpenAI se descarta para que no quede
	// un valor viejo guardado de cuando el servidor era de otro tipo. Un valor
	// negativo o absurdo se acota en vez de rechazarse.
	ctxTokens := normalizeContextTokens(in.Kind, in.ContextTokens)

	now := time.Now().Unix()
	if in.ID == "" {
		id, err := newID()
		if err != nil {
			return ModelServer{}, err
		}
		if _, err := s.db.Exec(
			`INSERT INTO model_servers (id, name, kind, base_url, encrypted_token, token_nonce, encrypted_headers, headers_nonce, insecure_tls, context_tokens, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id, name, in.Kind, baseURL, enc, nonce, encH, nonceH, in.InsecureTLS, ctxTokens, now, now,
		); err != nil {
			return ModelServer{}, i18n.Errorf(i18n.Msg{ES: "vault: guardando el servidor de modelos: %w", EN: "vault: saving the model server: %w"}, err)
		}
		return s.GetModelServer(id)
	}

	// Una sola sentencia armada según qué hacer con el token y las cabeceras,
	// para no pisar lo guardado cuando no se pidió tocarlo.
	set := []string{"name = ?", "kind = ?", "base_url = ?", "insecure_tls = ?", "context_tokens = ?", "updated_at = ?"}
	args := []any{name, in.Kind, baseURL, in.InsecureTLS, ctxTokens, now}
	switch {
	case token != "":
		set = append(set, "encrypted_token = ?", "token_nonce = ?")
		args = append(args, enc, nonce)
	case clearToken:
		set = append(set, "encrypted_token = NULL", "token_nonce = NULL")
	}
	if replaceHeaders {
		// encH/nonceH nil se guardan como NULL.
		set = append(set, "encrypted_headers = ?", "headers_nonce = ?")
		args = append(args, encH, nonceH)
	}
	args = append(args, in.ID)
	res, err := s.db.Exec(`UPDATE model_servers SET `+strings.Join(set, ", ")+` WHERE id = ?`, args...)
	if err != nil {
		return ModelServer{}, i18n.Errorf(i18n.Msg{ES: "vault: guardando el servidor de modelos: %w", EN: "vault: saving the model server: %w"}, err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ModelServer{}, i18n.Errorf(i18n.Msg{ES: "vault: el servidor de modelos no existe", EN: "vault: the model server does not exist"})
	}
	return s.GetModelServer(in.ID)
}

// MaxContextTokens es el tope de la ventana que se acepta guardar: ningún
// modelo local la pasa de unos pocos millones y un valor mayor es un error de
// tipeo que haría reservar memoria de más.
const MaxContextTokens = 4_194_304

func normalizeContextTokens(kind string, n int) int {
	if kind != ModelServerOllama || n < 0 {
		return 0
	}
	if n > MaxContextTokens {
		return MaxContextTokens
	}
	return n
}

// DeleteModelServer borra un servidor. Los chats que lo usaron conservan su
// agent_id, que a partir de ahí figura como agente desconocido.
func (s *Store) DeleteModelServer(id string) error {
	if _, err := s.db.Exec(`DELETE FROM model_servers WHERE id = ?`, id); err != nil {
		return i18n.Errorf(i18n.Msg{ES: "vault: borrando el servidor de modelos: %w", EN: "vault: deleting the model server: %w"}, err)
	}
	return nil
}

// ModelServerToken descifra el token guardado. Devuelve "" sin error cuando no
// hay: un servidor local sin autenticación es el caso normal.
//
// Sin binding: lo llama únicamente App para armar el cliente HTTP.
func (s *Store) ModelServerToken(id string) (string, error) {
	var enc, nonce []byte
	err := s.db.QueryRow(`SELECT encrypted_token, token_nonce FROM model_servers WHERE id = ?`, id).Scan(&enc, &nonce)
	if err == sql.ErrNoRows {
		return "", i18n.Errorf(i18n.Msg{ES: "vault: el servidor de modelos no existe", EN: "vault: the model server does not exist"})
	}
	if err != nil {
		return "", i18n.Errorf(i18n.Msg{ES: "vault: leyendo el token del servidor: %w", EN: "vault: reading the server token: %w"}, err)
	}
	if len(enc) == 0 || len(nonce) == 0 {
		return "", nil
	}
	key, err := s.gate.Key()
	if err != nil {
		return "", err
	}
	plain, err := mtcrypto.Decrypt(key, enc, nonce)
	if err != nil {
		return "", i18n.Errorf(i18n.Msg{ES: "vault: descifrando el token del servidor: %w", EN: "vault: decrypting the server token: %w"}, err)
	}
	return string(plain), nil
}
