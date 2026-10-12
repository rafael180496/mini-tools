package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"mini-tools/backend/agentchat"
	"mini-tools/backend/llm"
	"mini-tools/backend/vault"
)

// --- Gestor de proveedores: encendido, orden y modelo por defecto ------------

func agentIDs(t *testing.T, a *App) map[string]bool {
	t.Helper()
	list, err := a.ListAgents()
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]bool{}
	for _, ag := range list {
		out[ag.ID] = true
	}
	return out
}

func TestDisabledProviderLeavesTheCatalogButNotTheList(t *testing.T) {
	spanish(t)
	a, _ := newChatApp(t)
	id, _ := addRepo(t, a)
	ps := &pingServer{}
	ts := httptest.NewServer(ps)
	defer ts.Close()
	srv := saveServer(t, a, "GPU taller", ts.URL)
	agentID := agentchat.LLMPrefix + srv.ID

	// Nace encendido y con orden, sin que el formulario lo mande.
	if !srv.Enabled {
		t.Fatalf("un alta nace encendida: %+v", srv)
	}
	if !agentIDs(t, a)[agentID] {
		t.Fatal("encendido: tiene que estar en el catálogo")
	}

	if err := a.SetModelServerEnabled(srv.ID, false); err != nil {
		t.Fatal(err)
	}
	if agentIDs(t, a)[agentID] {
		t.Error("apagado: no debe estar en ListAgents")
	}
	list, _ := a.ListModelServers()
	if len(list) != 1 || list[0].Enabled {
		t.Errorf("apagado sigue en ListModelServers, con enabled=false: %+v", list)
	}

	// Un chat que lo usaba falla con un mensaje claro, en todos los caminos.
	check := func(what string, err error) {
		t.Helper()
		if err == nil || !strings.Contains(err.Error(), "GPU taller") || !strings.Contains(err.Error(), "desactivado") {
			t.Errorf("%s: %v", what, err)
		}
	}
	check("SendAgentChat", a.SendAgentChat("chat-x", "git", id, agentID, "hola", "", "", "", nil))
	_, err := a.AgentAskWith(agentID, "hola", "git", id)
	check("AgentAskWith", err)
	_, err = a.AskAgentOnce(id, agentID, "hola")
	check("AskAgentOnce", err)
	_, err = a.llmClientForTurn(agentID)
	check("llmClientForTurn", err)
	if ps.count() != 0 {
		t.Errorf("un proveedor apagado ni se consulta: %d chequeos", ps.count())
	}

	// Guardar el formulario de un proveedor apagado no lo enciende (ni un
	// formulario que no conoce `enabled` lo apaga).
	if _, err := a.SaveModelServer(ModelServer{ID: srv.ID, Name: "GPU taller", Kind: "ollama", BaseURL: ts.URL}, "", false, nil, false); err != nil {
		t.Fatal(err)
	}
	if list, _ := a.ListModelServers(); list[0].Enabled {
		t.Error("SaveModelServer no debe encender un proveedor apagado")
	}

	if err := a.SetModelServerEnabled(srv.ID, true); err != nil {
		t.Fatal(err)
	}
	if !agentIDs(t, a)[agentID] {
		t.Error("vuelto a encender, regresa al catálogo")
	}
	if err := a.SetModelServerEnabled("no-existe", true); err == nil {
		t.Error("un id desconocido debe fallar")
	}
}

func TestReorderModelServers(t *testing.T) {
	a, _ := newChatApp(t)
	names := func() string {
		list, err := a.ListModelServers()
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, s := range list {
			out = append(out, s.Name)
		}
		return strings.Join(out, ",")
	}
	// Altas en este orden: el desempate por nombre no interviene porque cada
	// alta va al final.
	z := saveServer(t, a, "zeta", "http://z")
	b := saveServer(t, a, "beta", "http://b")
	c := saveServer(t, a, "alfa", "http://c")
	if got := names(); got != "zeta,beta,alfa" {
		t.Fatalf("orden de alta = %s", got)
	}
	if err := a.ReorderModelServers([]string{c.ID, z.ID, b.ID}); err != nil {
		t.Fatal(err)
	}
	if got := names(); got != "alfa,zeta,beta" {
		t.Errorf("reordenado = %s", got)
	}
	// Ids repetidos o desconocidos se ignoran; los no mencionados quedan detrás.
	if err := a.ReorderModelServers([]string{b.ID, "fantasma", b.ID}); err != nil {
		t.Fatal(err)
	}
	if got := names(); got != "beta,alfa,zeta" {
		t.Errorf("parcial = %s", got)
	}
	list, _ := a.ListModelServers()
	for i, s := range list {
		if s.SortOrder != i {
			t.Errorf("sortOrder de %s = %d, quería %d", s.Name, s.SortOrder, i)
		}
	}
}

// --- Anthropic de punta a punta ----------------------------------------------

// anthropicStub es una Messages API de mentira: guarda los pedidos y contesta un
// stream corto.
type anthropicStub struct {
	mu     sync.Mutex
	bodies []map[string]any
}

func (s *anthropicStub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.URL.Path == "/v1/models":
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"data":[{"id":"claude-opus-5-5","type":"model","display_name":"Claude Opus 5.5","created_at":"2026-09-01T00:00:00Z"},{"id":"claude-haiku-5-5","type":"model","display_name":"Claude Haiku 5.5","created_at":"2026-08-01T00:00:00Z"}],"has_more":false}`)
	case strings.HasPrefix(r.URL.Path, "/v1/models/"):
		http.NotFound(w, r)
	case r.URL.Path == "/v1/messages":
		raw, _ := io.ReadAll(r.Body)
		var b map[string]any
		_ = json.Unmarshal(raw, &b)
		s.mu.Lock()
		s.bodies = append(s.bodies, b)
		s.mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "event: message_start\ndata: "+`{"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"claude-opus-5-5","content":[],"stop_reason":null,"usage":{"input_tokens":20,"cache_creation_input_tokens":5,"cache_read_input_tokens":75,"output_tokens":1}}}`+"\n\n")
		fmt.Fprint(w, "event: content_block_start\ndata: "+`{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`+"\n\n")
		fmt.Fprint(w, "event: content_block_delta\ndata: "+`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hola desde Claude"}}`+"\n\n")
		fmt.Fprint(w, "event: content_block_stop\ndata: "+`{"type":"content_block_stop","index":0}`+"\n\n")
		fmt.Fprint(w, "event: message_delta\ndata: "+`{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":12}}`+"\n\n")
		fmt.Fprint(w, "event: message_stop\ndata: "+`{"type":"message_stop"}`+"\n\n")
	default:
		http.NotFound(w, r)
	}
}

func (s *anthropicStub) model(i int) any {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.bodies[i]["model"]
}

func TestAnthropicProviderEndToEnd(t *testing.T) {
	spanish(t)
	a, events := newChatApp(t)
	id, _ := addRepo(t, a)
	stub := &anthropicStub{}
	ts := httptest.NewServer(stub)
	defer ts.Close()

	// Sin URL se guarda la oficial; el vendor es «Anthropic».
	def, err := a.SaveModelServer(ModelServer{Name: "Claude oficial", Kind: "anthropic"}, "sk-ant-x", false, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	if def.BaseURL != llm.DefaultAnthropicBaseURL || def.Kind != "anthropic" || !def.HasToken || def.ContextTokens != 0 {
		t.Fatalf("alta Anthropic: %+v", def)
	}
	if ag := modelServerAgent(vault.ModelServer{ID: def.ID, Name: "Claude oficial", Kind: vault.ModelServerAnthropic, BaseURL: def.BaseURL}); ag.Vendor != "Anthropic" || !strings.Contains(ag.Note, "Anthropic") {
		t.Errorf("agente: %+v", ag)
	}
	if _, err := a.SaveModelServer(ModelServer{Name: "raro", Kind: "gemini", BaseURL: "http://x"}, "", false, nil, false); err == nil {
		t.Error("un tipo desconocido debe rechazarse")
	}

	// Un proxy con /v1 al final se normaliza.
	srv, err := a.SaveModelServer(ModelServer{Name: "Claude proxy", Kind: "anthropic", BaseURL: ts.URL + "/v1/"}, "sk-ant-x", false, nil, false)
	if err != nil || srv.BaseURL != ts.URL {
		t.Fatalf("proxy = %+v, %v", srv, err)
	}
	agentID := agentchat.LLMPrefix + srv.ID

	// La prueba de conexión usa la lista de modelos (no hay endpoint de versión).
	probe, err := a.TestModelServer("anthropic", ts.URL, "sk-ant-x", "", false, nil)
	if err != nil || !probe.OK || probe.Version != "" || len(probe.Models) != 2 {
		t.Fatalf("probe = %+v, %v", probe, err)
	}
	if h, err := a.ModelServerHealth(srv.ID); err != nil || !h.OK || len(h.Models) != 2 {
		t.Fatalf("health = %+v, %v", h, err)
	}

	// Administración: solo listar.
	models, err := a.ModelServerModels(srv.ID)
	if err != nil || len(models) != 2 {
		t.Fatalf("ModelServerModels = %+v, %v", models, err)
	}
	if _, err := a.ModelServerPull(srv.ID, "claude-x"); err == nil || !strings.Contains(err.Error(), "Anthropic") {
		t.Errorf("pull debe ser no soportado, nombrando Anthropic: %v", err)
	}

	// Sin modelo ni predeterminado: claude-opus-5-5.
	if out, err := a.AgentAskWith(agentID, "hola", "git", id); err != nil || out != "Hola desde Claude" {
		t.Fatalf("ask = %q, %v", out, err)
	}
	if stub.model(0) != "claude-opus-5-5" {
		t.Errorf("modelo sin elegir = %v", stub.model(0))
	}

	// Con un modelo predeterminado del proveedor.
	if _, err := a.SaveModelServer(ModelServer{ID: srv.ID, Name: srv.Name, Kind: "anthropic", BaseURL: srv.BaseURL, DefaultModel: " claude-haiku-5-5 "}, "", false, nil, false); err != nil {
		t.Fatal(err)
	}
	if list, _ := a.ListModelServers(); list[1].DefaultModel != "claude-haiku-5-5" {
		t.Errorf("defaultModel no se guardó recortado: %+v", list)
	}
	if _, err := a.AgentAskWith(agentID, "hola", "git", id); err != nil {
		t.Fatal(err)
	}
	if stub.model(1) != "claude-haiku-5-5" {
		t.Errorf("modelo predeterminado del proveedor = %v", stub.model(1))
	}

	// Un turno guardado deja modelo, duración y tokens de caché para el consumo.
	client, err := a.llmClientForTurn(agentID)
	if err != nil {
		t.Fatal(err)
	}
	if err := a.sendRecorded("git", id, "hola", agentchat.Turn{SessionID: "chat-1", AgentID: agentID, Prompt: "hola", LLM: client}); err != nil {
		t.Fatal(err)
	}
	waitTurnEnd(t, a, events, "chat-1")
	rep, err := a.ModelServerUsage(7)
	if err != nil {
		t.Fatal(err)
	}
	var u ModelServerUsage
	for _, s := range rep.Servers {
		if s.AgentID == agentID {
			u = s
		}
	}
	// 20 + 5 + 75 de entrada (la caché cuenta como entrada) y 12 de salida.
	if u.Kind != "anthropic" || u.Totals.Turns != 1 || u.Totals.Input != 100 || u.Totals.Output != 12 || u.Totals.Total != 112 || u.Totals.CacheRead != 75 || u.Totals.CacheWrite != 5 {
		t.Fatalf("consumo = %+v", u)
	}
	if len(u.ByModel) != 1 || u.ByModel[0].Model != "claude-haiku-5-5" || u.ByModel[0].Totals.CacheRead != 75 {
		t.Errorf("byModel = %+v", u.ByModel)
	}
}
