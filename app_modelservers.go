package main

import (
	"context"
	"net"
	"net/url"
	"strings"
	"time"

	"mini-tools/backend/agentchat"
	"mini-tools/backend/agentmodels"
	"mini-tools/backend/agents"
	"mini-tools/backend/i18n"
	"mini-tools/backend/llm"
	"mini-tools/backend/vault"
)

// Proveedores de IA (llamados "servidores de modelos" en el código): Ollama,
// cualquier servidor compatible con la API de OpenAI (LM Studio, vLLM,
// llama.cpp server, OpenRouter, Groq…) y la API de Anthropic, locales o
// remotos.
//
// Cada uno entra al catálogo de agentes con el id `llm:<serverId>` y vendor
// "Ollama", "OpenAI-compatible" o "Anthropic", así que aparece en todos los selectores y
// en AgentAsk/AgentAskWith sin cambiar ninguna firma. Lo que hacen por dentro
// vive en backend/llm (el cliente HTTP) y backend/agentchat (el runner que
// emite los mismos eventos que un CLI).
//
// **El token nunca cruza hacia el frontend**: solo viaja HasToken. Todos los
// métodos pasan por requireUnlocked.

// ModelServer es un servidor de modelos tal como lo ve la interfaz.
type ModelServer struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Kind     string `json:"kind"` // "ollama" | "openai" | "anthropic"
	BaseURL  string `json:"baseUrl"`
	HasToken bool   `json:"hasToken"`
	// IsLocal es true si el servidor está en ESTA máquina (host de loopback).
	// Lo calcula el backend a partir de BaseURL —no se guarda ni se acepta al
	// guardar— para que la interfaz pueda advertir, antes de darle
	// herramientas de archivos a un modelo, que lo que lea viaja a otro host.
	IsLocal bool `json:"isLocal"`
	// InsecureTLS: no verificar el certificado de ESTE servidor (certificado
	// propio o autofirmado de una red interna). Apagado por defecto; es una
	// preferencia que sí viaja y se guarda.
	InsecureTLS bool `json:"insecureTls"`
	// ContextTokens: ventana de contexto que se le pide a un servidor Ollama
	// (options.num_ctx). 0 = la que traiga el servidor. Un servidor OpenAI no
	// la admite por petición: se guarda siempre 0.
	ContextTokens int `json:"contextTokens"`
	// Enabled: un proveedor apagado sigue en esta lista pero no aparece en el
	// catálogo de agentes ni en los selectores, y un chat que lo usaba falla con
	// un mensaje claro. SaveModelServer lo IGNORA (un alta nace encendida): se
	// cambia con SetModelServerEnabled.
	Enabled bool `json:"enabled"`
	// DefaultModel es el modelo que se usa cuando un turno no elige ninguno;
	// "" = el primero que liste el servidor (Anthropic: claude-opus-5-5).
	DefaultModel string `json:"defaultModel"`
	// SortOrder es la posición en la lista (menor primero). SaveModelServer lo
	// IGNORA: se cambia con ReorderModelServers.
	SortOrder int `json:"sortOrder"`
	// HeaderNames son los NOMBRES de las cabeceras propias configuradas
	// (X-Api-Key…). Los valores nunca cruzan hacia el frontend, igual que el
	// token. Siempre un arreglo, nunca null.
	HeaderNames []string `json:"headerNames"`
	CreatedAt   int64    `json:"createdAt"`
	UpdatedAt   int64    `json:"updatedAt"`
}

// ModelServerProbe es el resultado de probar una conexión. Un servidor caído
// NO es un error de la llamada: es justo la respuesta que se vino a buscar, y
// viaja en Error con OK=false.
type ModelServerProbe struct {
	OK      bool     `json:"ok"`
	Version string   `json:"version"`
	Models  []string `json:"models"`
	Error   string   `json:"error"`
	// LatencyMs es lo que tardó el chequeo; CheckedAt, cuándo se hizo (unix
	// ms). Con ModelServerHealth pueden venir del caché: CheckedAt dice cuán
	// vieja es la respuesta.
	LatencyMs int64 `json:"latencyMs"`
	CheckedAt int64 `json:"checkedAt"`
}

func toModelServer(m vault.ModelServer) ModelServer {
	names := m.HeaderNames
	if names == nil {
		names = []string{}
	}
	return ModelServer{
		ID: m.ID, Name: m.Name, Kind: m.Kind, BaseURL: m.BaseURL,
		HasToken: m.HasToken, IsLocal: isLoopbackURL(m.BaseURL),
		InsecureTLS: m.InsecureTLS, ContextTokens: m.ContextTokens, HeaderNames: names,
		Enabled: m.Enabled, DefaultModel: m.DefaultModel, SortOrder: m.SortOrder,
		CreatedAt: m.CreatedAt, UpdatedAt: m.UpdatedAt,
	}
}

// isLoopbackURL dice si la URL apunta a esta máquina: `localhost`, cualquier
// 127.x.x.x o ::1. No es "la red local": un servidor en 192.168.x.x o con un
// nombre de la LAN es remoto a estos efectos, porque es otra máquina que
// recibe el contenido de los archivos. `0.0.0.0` también cuenta (en un cliente
// conecta a esta misma máquina).
func isLoopbackURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	host := strings.ToLower(u.Hostname())
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && (ip.IsLoopback() || ip.IsUnspecified())
}

// ListModelServers devuelve los servidores guardados, sin sus tokens.
func (a *App) ListModelServers() ([]ModelServer, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	list, err := a.vault.ListModelServers()
	if err != nil {
		return nil, err
	}
	out := make([]ModelServer, 0, len(list))
	for _, m := range list {
		out = append(out, toModelServer(m))
	}
	return out, nil
}

// SaveModelServer crea (id vacío) o actualiza un servidor. token "" conserva
// el guardado; clearToken lo borra. s.DefaultModel se guarda; s.Enabled y
// s.SortOrder se ignoran (ver SetModelServerEnabled y ReorderModelServers). Un
// proveedor Anthropic con la URL vacía guarda la oficial.
//
// headers son las cabeceras propias (nombre → valor, los valores van
// cifrados): replaceHeaders=false conserva las guardadas e ignora headers;
// true las reemplaza, y un mapa vacío las borra todas. `Authorization` solo se
// admite si el servidor no tiene token. s.InsecureTLS se guarda.
func (a *App) SaveModelServer(s ModelServer, token string, clearToken bool, headers map[string]string, replaceHeaders bool) (ModelServer, error) {
	if err := a.requireUnlocked(); err != nil {
		return ModelServer{}, err
	}
	saved, err := a.vault.SaveModelServer(vault.ModelServer{ID: s.ID, Name: s.Name, Kind: s.Kind, BaseURL: llm.NormalizeBaseURLFor(s.Kind, s.BaseURL), InsecureTLS: s.InsecureTLS, ContextTokens: s.ContextTokens, DefaultModel: s.DefaultModel}, token, clearToken, headers, replaceHeaders)
	if err != nil {
		return ModelServer{}, err
	}
	// Cambió la URL, el token, las cabeceras o el TLS: lo que el caché sabía
	// del servidor ya no vale.
	a.modelHealth.invalidate(saved.ID)
	return toModelServer(saved), nil
}

// SetModelServerEnabled enciende o apaga un proveedor sin tocar el resto de su
// configuración. Apagado no aparece en el catálogo de agentes (ListAgents) ni en
// los selectores, pero sigue en ListModelServers para poder volver a prenderlo;
// un turno que ya estaba en vuelo termina por su cuenta.
func (a *App) SetModelServerEnabled(id string, enabled bool) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.SetModelServerEnabled(id, enabled)
}

// ReorderModelServers fija el orden de los proveedores: los ids dados, en ese
// orden, y detrás los que no se mencionaron. Un id desconocido se ignora.
func (a *App) ReorderModelServers(ids []string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.ReorderModelServers(ids)
}

// DeleteModelServer borra un servidor. Un chat que lo usaba queda apuntando a
// un agente que ya no existe (se muestra como desconocido); un turno en vuelo
// termina por su cuenta.
func (a *App) DeleteModelServer(id string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	if err := a.vault.DeleteModelServer(id); err != nil {
		return err
	}
	a.modelHealth.invalidate(id)
	return nil
}

// probeTimeout acota la prueba entera. Un remoto lento tiene que contestar
// "no responde" en vez de dejar el botón girando.
const probeTimeout = 20 * time.Second

// TestModelServer prueba una conexión: versión (Ollama) y modelos.
//
// Con serverID y token vacío usa el token guardado de ese servidor, para
// poder probar uno ya guardado sin volver a escribir su clave; con headers nil
// usa las cabeceras guardadas (un mapa, aunque vacío, es lo que se escribió en
// el formulario); kind y baseURL vacíos también se completan con lo guardado.
// insecureTLS es el del formulario, no el guardado. Todos los fallos de
// conexión van en Probe.Error.
func (a *App) TestModelServer(kind, baseURL, token, serverID string, insecureTLS bool, headers map[string]string) (ModelServerProbe, error) {
	if err := a.requireUnlocked(); err != nil {
		return ModelServerProbe{}, err
	}
	fail := func(err error) (ModelServerProbe, error) {
		return ModelServerProbe{Models: []string{}, Error: err.Error(), CheckedAt: time.Now().UnixMilli()}, nil
	}

	if serverID != "" {
		saved, err := a.vault.GetModelServer(serverID)
		if err != nil {
			return fail(err)
		}
		if kind == "" {
			kind = saved.Kind
		}
		if baseURL == "" {
			baseURL = saved.BaseURL
		}
		if token == "" {
			if token, err = a.vault.ModelServerToken(serverID); err != nil {
				return fail(err)
			}
		}
		if headers == nil {
			if headers, err = a.vault.ModelServerHeaders(serverID); err != nil {
				return fail(err)
			}
		}
	}
	headers, err := vault.ValidateModelServerHeaders(headers, token != "")
	if err != nil {
		return fail(err)
	}

	client, err := llm.New(kind, baseURL, llm.Options{Token: token, Headers: headers, InsecureTLS: insecureTLS})
	if err != nil {
		return fail(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	defer cancel()

	// Mismo chequeo que usa el servidor guardado, pero con el plazo largo de
	// "probar": acá la persona espera una respuesta y un remoto lento merece
	// el beneficio de la duda.
	start := time.Now()
	version, err := client.Version(ctx)
	if err != nil {
		return fail(err)
	}
	models, err := client.Models(ctx)
	if err != nil {
		return fail(err)
	}
	if models == nil {
		models = []string{}
	}
	return ModelServerProbe{OK: true, Version: version, Models: models, LatencyMs: time.Since(start).Milliseconds(), CheckedAt: time.Now().UnixMilli()}, nil
}

// localOllamaURL es donde escucha Ollama por defecto.
const localOllamaURL = "http://localhost:11434"

// DetectLocalOllama dice si hay un Ollama local para ofrecer con un clic: true
// solo si contesta en localhost:11434 Y todavía no hay un servidor guardado
// que apunte ahí. La espera es corta a propósito: se llama al abrir la
// configuración y no puede demorarla.
func (a *App) DetectLocalOllama() (bool, error) {
	if err := a.requireUnlocked(); err != nil {
		return false, err
	}
	saved, err := a.vault.ListModelServers()
	if err != nil {
		return false, err
	}
	for _, m := range saved {
		if isLocalOllamaURL(m.BaseURL) {
			return false, nil
		}
	}
	client, err := llm.New(llm.KindOllama, localOllamaURL, llm.Options{})
	if err != nil {
		return false, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	_, err = client.Version(ctx)
	return err == nil, nil
}

// isLocalOllamaURL reconoce una URL que apunta al puerto por defecto de
// Ollama en esta máquina, con cualquiera de los nombres con que se la escribe.
func isLocalOllamaURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Port() != "11434" {
		return false
	}
	switch u.Hostname() {
	case "localhost", "127.0.0.1", "::1", "0.0.0.0":
		return true
	}
	return false
}

// --- Integración con el catálogo de agentes --------------------------------

// modelServerAgent presenta un servidor como una entrada del catálogo de
// agentes. Sin comando, sin key de entorno y sin login: no es un programa.
// Available es "configurado": probar la conexión es un botón, no algo que corra
// en cada listado, para que un remoto caído no trabe la lista.
func modelServerAgent(m vault.ModelServer) agents.Agent {
	vendor := "OpenAI-compatible"
	note := i18n.Msg{ES: "Servidor de modelos compatible con la API de OpenAI.", EN: "OpenAI-compatible model server."}
	switch m.Kind {
	case vault.ModelServerOllama:
		vendor = "Ollama"
		note = i18n.Msg{ES: "Servidor de modelos Ollama.", EN: "Ollama model server."}
	case vault.ModelServerAnthropic:
		vendor = "Anthropic"
		note = i18n.Msg{ES: "API de Anthropic (Claude).", EN: "Anthropic API (Claude)."}
	}
	// Un servidor remoto lo dice en la nota (el tooltip del selector): con
	// herramientas de archivos, lo que el modelo lea viaja a esa máquina.
	if !isLoopbackURL(m.BaseURL) {
		note = i18n.Msg{
			ES: note.ES + " Remoto: lo que el agente lea de tus archivos se envía a ese servidor.",
			EN: note.EN + " Remote: whatever the agent reads from your files is sent to that server.",
		}
	}
	return agents.Agent{
		ID:        agentchat.LLMPrefix + m.ID,
		Label:     m.Name,
		Vendor:    vendor,
		Available: true,
		Note:      i18n.T(note),
	}
}

// agentCatalog es el catálogo de CLIs más los servidores de modelos.
func (a *App) agentCatalog() ([]agents.Agent, error) {
	configs, err := a.vault.ListAgentConfigs()
	if err != nil {
		return nil, err
	}
	overrides := make(map[string]agents.Override, len(configs))
	for id, c := range configs {
		overrides[id] = agents.Override{Command: c.Command, HasKey: c.HasKey}
	}
	list := agents.List(overrides)

	servers, err := a.vault.ListModelServers()
	if err != nil {
		return nil, err
	}
	for _, m := range servers {
		// Un proveedor apagado no es un agente que se pueda elegir.
		if m.Enabled {
			list = append(list, modelServerAgent(m))
		}
	}
	return list, nil
}

// llmServer arma el cliente HTTP de un agente `llm:<id>`, con el token y las
// cabeceras descifrados y la preferencia de TLS. Es el único lugar donde esos
// secretos salen del vault, y se quedan del lado de Go.
func (a *App) llmServer(agentID string) (vault.ModelServer, llm.Client, error) {
	id := agentID[len(agentchat.LLMPrefix):]
	m, err := a.vault.GetModelServer(id)
	if err != nil {
		return vault.ModelServer{}, nil, err
	}
	token, err := a.vault.ModelServerToken(id)
	if err != nil {
		return vault.ModelServer{}, nil, err
	}
	headers, err := a.vault.ModelServerHeaders(id)
	if err != nil {
		return vault.ModelServer{}, nil, err
	}
	client, err := llm.New(m.Kind, m.BaseURL, llm.Options{Token: token, Headers: headers, InsecureTLS: m.InsecureTLS, ContextTokens: m.ContextTokens})
	if err != nil {
		return vault.ModelServer{}, nil, err
	}
	return m, client, nil
}

// llmContextTokens es la ventana de contexto configurada del servidor de un
// agente `llm:<id>` (0 si no hay o no se pudo leer). Solo alimenta el aviso del
// chat; un fallo acá no debe tumbar el turno.
func (a *App) llmContextTokens(agentID string) int {
	if !agentchat.IsLLM(agentID) {
		return 0
	}
	m, err := a.vault.GetModelServer(agentID[len(agentchat.LLMPrefix):])
	if err != nil {
		return 0
	}
	return m.ContextTokens
}

// llmClientFor es el cliente SIN chequeo previo: para el selector de modelos,
// que tiene su propio plan B si el servidor no responde. Los caminos que
// arrancan un turno usan llmClientForTurn.
func (a *App) llmClientFor(agentID string) (llm.Client, error) {
	_, client, err := a.llmServer(agentID)
	return client, err
}

// llmModelCatalog arma el selector de modelos de un servidor. Si no se puede
// consultar devuelve solo "Por defecto", igual que un CLI cuyo listado falla:
// el selector no puede ser el que se rompa por un servidor caído.
func (a *App) llmModelCatalog(agentID string) agentmodels.Catalog {
	def := agentmodels.Model{
		ID:          "",
		Label:       i18n.T(i18n.Msg{ES: "Por defecto", EN: "Default"}),
		Description: i18n.T(i18n.Msg{ES: "El primero que devuelva el servidor", EN: "The first one the server returns"}),
	}
	cat := agentmodels.Catalog{Models: []agentmodels.Model{def}}

	server, client, err := a.llmServer(agentID)
	if err != nil {
		return cat
	}
	// Qué es "por defecto" lo decide el proveedor: su modelo predeterminado, o el
	// de Anthropic, o el primero que liste.
	if dm := providerDefaultModel(server, client); dm != "" {
		cat.Models[0].Description = i18n.T(i18n.Msg{ES: "Modelo predeterminado del proveedor: %s", EN: "The provider's default model: %s"}, dm)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	names, err := client.Models(ctx)
	if err != nil {
		return cat
	}
	for _, n := range names {
		cat.Models = append(cat.Models, agentmodels.Model{ID: n, Label: n})
	}
	return cat
}

// providerDefaultModel es el modelo que usa un turno que no eligió ninguno: el
// `defaultModel` del proveedor y, sin él, el propio del cliente (Anthropic). ""
// = el primero que liste el servidor.
func providerDefaultModel(m vault.ModelServer, c llm.Client) string {
	if m.DefaultModel != "" {
		return m.DefaultModel
	}
	if d, ok := c.(interface{ DefaultModel() string }); ok {
		return d.DefaultModel()
	}
	return ""
}

// errProviderDisabled es el error de un turno contra un proveedor apagado.
func errProviderDisabled(name string) error {
	return i18n.Errorf(i18n.Msg{
		ES: "app: el proveedor «%s» está desactivado — activalo en la configuración de proveedores de IA",
		EN: "app: the provider «%s» is disabled — turn it on in the AI providers settings",
	}, name)
}
