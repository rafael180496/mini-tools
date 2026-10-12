package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"mini-tools/backend/agentchat"
	"mini-tools/backend/i18n"
	"mini-tools/backend/vault"
)

func TestIsLocalOllamaURL(t *testing.T) {
	yes := []string{"http://localhost:11434", "http://127.0.0.1:11434/", "http://[::1]:11434", "http://localhost:11434/v1"}
	no := []string{"http://localhost:1234/v1", "https://gpu.empresa:11434", "http://localhost", "no es una url"}
	for _, u := range yes {
		if !isLocalOllamaURL(u) {
			t.Errorf("%q debería contar como Ollama local", u)
		}
	}
	for _, u := range no {
		if isLocalOllamaURL(u) {
			t.Errorf("%q no es Ollama local", u)
		}
	}
}

func TestModelServerAgentEntry(t *testing.T) {
	ag := modelServerAgent(vault.ModelServer{ID: "abc", Name: "Mi GPU", Kind: vault.ModelServerOpenAI})
	if ag.ID != "llm:abc" || ag.Label != "Mi GPU" || ag.Vendor != "OpenAI-compatible" || !ag.Available ||
		ag.Command != "" || ag.KeyEnv != "" || ag.LoginHint != "" || !agentchat.Supports(ag.ID) {
		t.Fatalf("entrada inesperada: %+v", ag)
	}
	if v := modelServerAgent(vault.ModelServer{ID: "x", Name: "o", Kind: vault.ModelServerOllama}).Vendor; v != "Ollama" {
		t.Fatalf("vendor = %q", v)
	}
}

// --- Chequeo previo, cabeceras y TLS -----------------------------------------

func spanish(t *testing.T) {
	t.Helper()
	prev := i18n.Lang()
	i18n.SetLang("es")
	t.Cleanup(func() { i18n.SetLang(prev) })
}

// fakeClock es un reloj manual para el caché del chequeo.
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

// pingServer es un Ollama de mentira que cuenta los chequeos y guarda las
// cabeceras que le llegan.
type pingServer struct {
	mu      sync.Mutex
	pings   int
	headers []http.Header
}

func (p *pingServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p.mu.Lock()
	p.headers = append(p.headers, r.Header.Clone())
	if r.URL.Path == "/api/version" {
		p.pings++
	}
	p.mu.Unlock()
	switch r.URL.Path {
	case "/api/version":
		fmt.Fprint(w, `{"version":"0.9.1"}`)
	case "/api/tags":
		fmt.Fprint(w, `{"models":[{"name":"llama3"}]}`)
	case "/api/chat":
		fmt.Fprint(w, `{"model":"llama3","message":{"role":"assistant","content":"hola"},"done":false}`+"\n"+`{"model":"llama3","message":{"content":""},"done":true}`+"\n")
	default:
		http.NotFound(w, r)
	}
}

func (p *pingServer) count() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.pings
}

func saveServer(t *testing.T, a *App, name, url string) ModelServer {
	t.Helper()
	s, err := a.SaveModelServer(ModelServer{Name: name, Kind: "ollama", BaseURL: url}, "", false, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// Con el servidor caído el turno ni empieza: error claro con nombre, host,
// causa y consejo; ni un evento, ni una fila de chat, en los tres caminos.
func TestPreflightBlocksTurnWhenServerDown(t *testing.T) {
	spanish(t)
	a, events := newChatApp(t)
	id, _ := addRepo(t, a)

	dead := httptest.NewServer(http.NotFoundHandler())
	url := dead.URL
	dead.Close()
	srv := saveServer(t, a, "GPU taller", url)
	agentID := agentchat.LLMPrefix + srv.ID

	host := strings.TrimPrefix(url, "http://")
	check := func(what string, err error) {
		t.Helper()
		if err == nil {
			t.Fatalf("%s: debería fallar con el servidor caído", what)
		}
		for _, want := range []string{"GPU taller", host, "rechazada", "Revisá que esté encendido y accesible desde esta máquina"} {
			if !strings.Contains(err.Error(), want) {
				t.Errorf("%s: el error no menciona %q: %v", what, want, err)
			}
		}
	}
	check("SendAgentChat", a.SendAgentChat("chat-x", "git", id, agentID, "hola", "", "", "", nil))
	_, err := a.AgentAskWith(agentID, "hola", "git", id)
	check("AgentAskWith", err)
	_, err = a.AskAgentOnce(id, agentID, "hola")
	check("AskAgentOnce", err)

	if chats, _ := a.vault.ListAllAgentChats(); len(chats) != 0 {
		t.Errorf("quedaron filas de chat: %+v", chats)
	}
	select {
	case ev := <-events:
		t.Errorf("no debería haber eventos: %+v", ev)
	default:
	}
}

// Un chequeo exitoso vale 30s; pasado ese plazo se vuelve a preguntar.
func TestPreflightCacheTTLAndInvalidation(t *testing.T) {
	a, _ := newChatApp(t)
	id, _ := addRepo(t, a)
	clock := &fakeClock{t: time.Unix(1_700_000_000, 0)}
	a.modelHealth.now = clock.now
	ps := &pingServer{}
	ts := httptest.NewServer(ps)
	defer ts.Close()
	srv := saveServer(t, a, "Local", ts.URL)
	agentID := agentchat.LLMPrefix + srv.ID

	ask := func() {
		t.Helper()
		if got, err := a.AgentAskWith(agentID, "hola", "git", id); err != nil || got != "hola" {
			t.Fatalf("AgentAskWith = %q, %v", got, err)
		}
	}
	ask()
	ask()
	if ps.count() != 1 {
		t.Fatalf("dentro de los 30s hubo %d chequeos, quería 1", ps.count())
	}
	// Una respuesta real renueva la vigencia: 25s + 25s desde el chequeo, pero
	// el chat contestó a los 25s.
	clock.advance(25 * time.Second)
	ask() // cache vigente → sin ping, y renueva
	clock.advance(25 * time.Second)
	ask()
	if ps.count() != 1 {
		t.Fatalf("una respuesta real debería renovar el caché: %d chequeos", ps.count())
	}
	clock.advance(31 * time.Second)
	ask()
	if ps.count() != 2 {
		t.Fatalf("pasados los 30s debería volver a preguntar: %d chequeos", ps.count())
	}
	// Guardar el servidor invalida.
	if _, err := a.SaveModelServer(srv, "", false, nil, false); err != nil {
		t.Fatal(err)
	}
	ask()
	if ps.count() != 3 {
		t.Fatalf("SaveModelServer debería invalidar: %d chequeos", ps.count())
	}
	// Borrarlo también; y el cliente ya no existe.
	if err := a.DeleteModelServer(srv.ID); err != nil {
		t.Fatal(err)
	}
	if _, ok := a.modelHealth.get(srv.ID, false); ok {
		t.Error("DeleteModelServer debería invalidar")
	}
}

// Un chequeo que arrancó antes de invalidar no puede guardar su resultado.
func TestHealthCacheIgnoresStaleProbe(t *testing.T) {
	var c modelHealthCache
	gen := c.begin("s")
	c.invalidate("s")
	c.put("s", gen, ModelServerProbe{OK: true}, true)
	if _, ok := c.get("s", false); ok {
		t.Error("un chequeo viejo no debería quedar en el caché")
	}
}

func TestModelServerHealth(t *testing.T) {
	a, _ := newChatApp(t)
	clock := &fakeClock{t: time.Unix(1_700_000_000, 0)}
	a.modelHealth.now = clock.now
	ps := &pingServer{}
	ts := httptest.NewServer(ps)
	defer ts.Close()
	srv := saveServer(t, a, "Local", ts.URL)

	p, err := a.ModelServerHealth(srv.ID)
	if err != nil || !p.OK || p.Version != "0.9.1" || len(p.Models) != 1 || p.Models[0] != "llama3" || p.CheckedAt == 0 || p.Error != "" {
		t.Fatalf("ModelServerHealth = %+v, %v", p, err)
	}
	again, _ := a.ModelServerHealth(srv.ID)
	if again.CheckedAt != p.CheckedAt || ps.count() != 1 {
		t.Errorf("la segunda llamada debería salir del caché: %d chequeos", ps.count())
	}
	clock.advance(31 * time.Second)
	if _, _ = a.ModelServerHealth(srv.ID); ps.count() != 2 {
		t.Errorf("vencido el caché debería chequear de nuevo: %d", ps.count())
	}

	// Un servidor caído no es un error de la llamada.
	dead := httptest.NewServer(http.NotFoundHandler())
	url := dead.URL
	dead.Close()
	down := saveServer(t, a, "Caído", url)
	p, err = a.ModelServerHealth(down.ID)
	if err != nil || p.OK || p.Error == "" || p.Models == nil {
		t.Fatalf("caído = %+v, %v", p, err)
	}
	// Un id que no existe tampoco revienta.
	if p, err = a.ModelServerHealth("no-existe"); err != nil || p.OK || p.Error == "" {
		t.Fatalf("inexistente = %+v, %v", p, err)
	}
}

// Las cabeceras y el token guardados viajan en el chequeo, en los modelos y en
// el chat; solo los nombres vuelven al frontend.
func TestModelServerHeadersReachTheServer(t *testing.T) {
	a, _ := newChatApp(t)
	id, _ := addRepo(t, a)
	ps := &pingServer{}
	ts := httptest.NewServer(ps)
	defer ts.Close()

	srv, err := a.SaveModelServer(ModelServer{Name: "Gateway", Kind: "ollama", BaseURL: ts.URL}, "tok-1", false,
		map[string]string{"X-Api-Key": "clave-secreta"}, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(srv.HeaderNames) != 1 || srv.HeaderNames[0] != "X-Api-Key" {
		t.Fatalf("HeaderNames = %v", srv.HeaderNames)
	}
	if raw, _ := json.Marshal(srv); strings.Contains(string(raw), "clave-secreta") || strings.Contains(string(raw), "tok-1") {
		t.Fatalf("un secreto cruzó hacia el frontend: %s", raw)
	}

	if _, err := a.AgentAskWith(agentchat.LLMPrefix+srv.ID, "hola", "git", id); err != nil {
		t.Fatal(err)
	}
	if _, err := a.ModelServerHealth(srv.ID); err != nil {
		t.Fatal(err)
	}
	ps.mu.Lock()
	n := len(ps.headers)
	for _, h := range ps.headers {
		if h.Get("X-Api-Key") != "clave-secreta" || h.Get("Authorization") != "Bearer tok-1" {
			t.Errorf("cabeceras = %v", h)
		}
	}
	ps.mu.Unlock()
	if n < 3 {
		t.Errorf("se esperaban al menos 3 requests (versión, chat, modelos), hubo %d", n)
	}

	// Authorization como cabecera choca con el token.
	if _, err := a.SaveModelServer(srv, "", false, map[string]string{"Authorization": "x"}, true); err == nil {
		t.Error("Authorization con token debería rechazarse")
	}
}

// TestModelServer completa token y cabeceras con lo guardado cuando vienen
// vacías, y usa las del formulario cuando vienen.
func TestTestModelServerUsesStoredSecretsAndFormHeaders(t *testing.T) {
	a, _ := newChatApp(t)
	ps := &pingServer{}
	ts := httptest.NewServer(ps)
	defer ts.Close()
	srv, err := a.SaveModelServer(ModelServer{Name: "G", Kind: "ollama", BaseURL: ts.URL}, "tok-guardado", false,
		map[string]string{"X-Api-Key": "guardada"}, true)
	if err != nil {
		t.Fatal(err)
	}
	last := func() http.Header {
		ps.mu.Lock()
		defer ps.mu.Unlock()
		return ps.headers[len(ps.headers)-1]
	}

	p, err := a.TestModelServer("", "", "", srv.ID, false, nil)
	if err != nil || !p.OK || p.LatencyMs < 0 || p.CheckedAt == 0 {
		t.Fatalf("probe = %+v, %v", p, err)
	}
	if h := last(); h.Get("X-Api-Key") != "guardada" || h.Get("Authorization") != "Bearer tok-guardado" {
		t.Errorf("debería usar lo guardado: %v", h)
	}
	// Con cabeceras del formulario, esas mandan (el token sigue siendo el guardado).
	if p, _ = a.TestModelServer("", "", "", srv.ID, false, map[string]string{"X-Otra": "nueva"}); !p.OK {
		t.Fatalf("probe = %+v", p)
	}
	if h := last(); h.Get("X-Otra") != "nueva" || h.Get("X-Api-Key") != "" || h.Get("Authorization") != "Bearer tok-guardado" {
		t.Errorf("debería usar las del formulario: %v", h)
	}
	// Una cabecera inválida es un fallo del probe, no un error de la llamada.
	if p, err = a.TestModelServer("ollama", ts.URL, "", "", false, map[string]string{"Host": "x"}); err != nil || p.OK || p.Error == "" {
		t.Errorf("cabecera reservada: %+v, %v", p, err)
	}
}

// Un certificado propio da el mensaje que sugiere la opción; con ella
// encendida el mismo servidor conecta.
func TestTestModelServerSelfSignedTLS(t *testing.T) {
	spanish(t)
	a, _ := newChatApp(t)
	ts := httptest.NewTLSServer(&pingServer{})
	defer ts.Close()

	p, err := a.TestModelServer("ollama", ts.URL, "", "", false, nil)
	if err != nil || p.OK || !strings.Contains(p.Error, "certificado no confiable") || !strings.Contains(p.Error, "Aceptar certificado autofirmado") {
		t.Fatalf("sin la opción: %+v, %v", p, err)
	}
	p, err = a.TestModelServer("ollama", ts.URL, "", "", true, nil)
	if err != nil || !p.OK {
		t.Fatalf("con la opción: %+v, %v", p, err)
	}

	// Guardado con InsecureTLS, el chequeo previo del chat también conecta.
	id, _ := addRepo(t, a)
	srv, err := a.SaveModelServer(ModelServer{Name: "Interno", Kind: "ollama", BaseURL: ts.URL, InsecureTLS: true}, "", false, nil, false)
	if err != nil || !srv.InsecureTLS {
		t.Fatalf("save: %+v, %v", srv, err)
	}
	if got, err := a.AgentAskWith(agentchat.LLMPrefix+srv.ID, "hola", "git", id); err != nil || got != "hola" {
		t.Fatalf("AgentAskWith = %q, %v", got, err)
	}
	// Y sin la opción el chequeo previo falla con la sugerencia.
	strict, _ := a.SaveModelServer(ModelServer{Name: "Estricto", Kind: "ollama", BaseURL: ts.URL}, "", false, nil, false)
	_, err = a.AgentAskWith(agentchat.LLMPrefix+strict.ID, "hola", "git", id)
	if err == nil || !strings.Contains(err.Error(), "Aceptar certificado autofirmado") || !strings.Contains(err.Error(), "Estricto") {
		t.Fatalf("err = %v", err)
	}
}

// La ventana de contexto guardada llega al servidor como options.num_ctx en el
// chat; y llmContextTokens la expone para el aviso del chat.
func TestModelServerContextTokensReachChat(t *testing.T) {
	a, _ := newChatApp(t)
	id, _ := addRepo(t, a)
	var mu sync.Mutex
	var chats []map[string]any
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/version":
			fmt.Fprint(w, `{"version":"0.9.1"}`)
		case "/api/tags":
			fmt.Fprint(w, `{"models":[{"name":"llama3"}]}`)
		case "/api/chat":
			var b map[string]any
			_ = json.NewDecoder(r.Body).Decode(&b)
			mu.Lock()
			chats = append(chats, b)
			mu.Unlock()
			fmt.Fprint(w, `{"model":"llama3","message":{"role":"assistant","content":"hola"},"done":false}`+"\n"+`{"model":"llama3","message":{"content":""},"done":true}`+"\n")
		default:
			http.NotFound(w, r)
		}
	}))
	defer ts.Close()

	srv, err := a.SaveModelServer(ModelServer{Name: "Ctx", Kind: "ollama", BaseURL: ts.URL, ContextTokens: 16384}, "", false, nil, false)
	if err != nil || srv.ContextTokens != 16384 {
		t.Fatalf("SaveModelServer = %+v, %v", srv, err)
	}
	agentID := agentchat.LLMPrefix + srv.ID
	if got := a.llmContextTokens(agentID); got != 16384 {
		t.Errorf("llmContextTokens = %d", got)
	}
	if _, err := a.AgentAskWith(agentID, "hola", "git", id); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(chats) != 1 {
		t.Fatalf("chats = %d", len(chats))
	}
	if opts, _ := chats[0]["options"].(map[string]any); opts["num_ctx"] != float64(16384) {
		t.Errorf("options = %v", chats[0]["options"])
	}
}
