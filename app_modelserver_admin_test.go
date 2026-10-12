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
	"time"

	"mini-tools/backend/llm"
)

// fakeOllamaAdmin es un Ollama de mentira con lo que usa la administración.
type fakeOllamaAdmin struct {
	mu      sync.Mutex
	auth    []string
	deleted []string
	// pullLines se emiten tal cual en /api/pull; si block no es nil, después de
	// las líneas el handler espera a que el cliente corte.
	pullLines []string
	block     chan struct{}
}

func (f *fakeOllamaAdmin) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	f.auth = append(f.auth, r.Header.Get("Authorization")+"|"+r.Header.Get("X-Api-Key"))
	f.mu.Unlock()
	switch r.URL.Path {
	case "/api/tags":
		fmt.Fprint(w, `{"models":[{"name":"llama3:8b","size":4700000000,"modified_at":"2026-03-01T10:00:00Z","details":{"family":"llama","parameter_size":"8B","quantization_level":"Q4_0"}}]}`)
	case "/api/ps":
		fmt.Fprint(w, `{"models":[{"name":"llama3:8b","size":6000,"size_vram":6000,"expires_at":"2026-03-01T10:05:00Z"}]}`)
	case "/api/show":
		fmt.Fprint(w, `{"template":"{{ .Prompt }}","details":{"family":"llama"},"model_info":{"llama.context_length":8192}}`)
	case "/api/delete":
		b, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(b, &body)
		name, _ := body["model"].(string)
		if name == "fantasma" {
			w.WriteHeader(404)
			fmt.Fprint(w, `{"error":"model 'fantasma' not found"}`)
			return
		}
		f.mu.Lock()
		f.deleted = append(f.deleted, name)
		f.mu.Unlock()
	case "/api/generate":
		fmt.Fprint(w, `{"done":true,"done_reason":"unload"}`)
	case "/api/pull":
		for _, l := range f.pullLines {
			fmt.Fprintln(w, l)
		}
		if fl, ok := w.(http.Flusher); ok {
			fl.Flush()
		}
		if f.block != nil {
			select {
			case <-r.Context().Done():
			case <-f.block:
			}
		}
	default:
		http.NotFound(w, r)
	}
}

// pullCollector junta los eventos de las descargas.
type pullCollector struct {
	mu     sync.Mutex
	events []ModelPullEvent
	names  []string
	done   chan ModelPullEvent
}

func newPullCollector(a *App) *pullCollector {
	c := &pullCollector{done: make(chan ModelPullEvent, 8)}
	a.modelPulls.emit = func(event string, data any) {
		ev := data.(ModelPullEvent)
		c.mu.Lock()
		c.events = append(c.events, ev)
		c.names = append(c.names, event)
		c.mu.Unlock()
		if ev.Done {
			c.done <- ev
		}
	}
	return c
}

func (c *pullCollector) waitDone(t *testing.T) ModelPullEvent {
	t.Helper()
	select {
	case ev := <-c.done:
		return ev
	case <-time.After(5 * time.Second):
		t.Fatal("la descarga no terminó")
		return ModelPullEvent{}
	}
}

func adminApp(t *testing.T, h http.Handler) (*App, ModelServer, *httptest.Server) {
	t.Helper()
	a, _ := newChatApp(t)
	ts := httptest.NewServer(h)
	t.Cleanup(ts.Close)
	srv, err := a.SaveModelServer(ModelServer{Name: "GPU", Kind: "ollama", BaseURL: ts.URL}, "sk-secreto", false, map[string]string{"X-Api-Key": "k1"}, true)
	if err != nil {
		t.Fatal(err)
	}
	return a, srv, ts
}

func TestModelServerAdminReadsWithStoredCredentials(t *testing.T) {
	f := &fakeOllamaAdmin{}
	a, srv, _ := adminApp(t, f)

	models, err := a.ModelServerModels(srv.ID)
	if err != nil || len(models) != 1 || models[0].Name != "llama3:8b" || models[0].Family != "llama" || models[0].Size != 4700000000 {
		t.Fatalf("modelos: %+v, %v", models, err)
	}
	running, err := a.ModelServerRunning(srv.ID)
	if err != nil || len(running) != 1 || running[0].SizeVRAM != 6000 {
		t.Fatalf("cargados: %+v, %v", running, err)
	}
	d, err := a.ModelServerShowModel(srv.ID, "llama3:8b")
	if err != nil || d.ContextLength != 8192 || d.Template != "{{ .Prompt }}" {
		t.Fatalf("detalle: %+v, %v", d, err)
	}
	if err := a.ModelServerUnload(srv.ID, "llama3:8b"); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.auth) != 4 {
		t.Fatalf("llamadas = %d", len(f.auth))
	}
	for _, got := range f.auth {
		if got != "Bearer sk-secreto|k1" {
			t.Errorf("credenciales = %q", got)
		}
	}
}

func TestModelServerAdminValidatesNames(t *testing.T) {
	a, srv, _ := adminApp(t, &fakeOllamaAdmin{})
	for _, bad := range []string{"", "con espacio", "x\ny"} {
		if _, err := a.ModelServerPull(srv.ID, bad); err == nil {
			t.Errorf("pull %q debería rechazarse", bad)
		}
		if err := a.ModelServerDeleteModel(srv.ID, bad); err == nil {
			t.Errorf("delete %q debería rechazarse", bad)
		}
		if _, err := a.ModelServerShowModel(srv.ID, bad); err == nil {
			t.Errorf("show %q debería rechazarse", bad)
		}
		if err := a.ModelServerUnload(srv.ID, bad); err == nil {
			t.Errorf("unload %q debería rechazarse", bad)
		}
	}
	if _, err := a.ModelServerModels("no-existe"); err == nil {
		t.Error("un servidor inexistente debería fallar")
	}
}

func TestModelServerPullEmitsProgressAndInvalidates(t *testing.T) {
	f := &fakeOllamaAdmin{pullLines: []string{
		`{"status":"pulling manifest"}`,
		`{"status":"pulling aaa","digest":"sha256:aaa","total":1000,"completed":250}`,
		`{"status":"pulling aaa","digest":"sha256:aaa","total":1000,"completed":1000}`,
		`{"status":"success"}`,
	}}
	a, srv, _ := adminApp(t, f)
	col := newPullCollector(a)

	// Un chequeo cacheado: la descarga lo tiene que invalidar.
	gen := a.modelHealth.begin(srv.ID)
	a.modelHealth.put(srv.ID, gen, ModelServerProbe{OK: true, Models: []string{"viejo"}}, true)
	if _, ok := a.modelHealth.get(srv.ID, true); !ok {
		t.Fatal("el chequeo debería estar cacheado")
	}

	id, err := a.ModelServerPull(srv.ID, " tiny:1b ")
	if err != nil || id == "" {
		t.Fatalf("pull = %q, %v", id, err)
	}
	last := col.waitDone(t)
	if last.PullID != id || last.Model != "tiny:1b" || last.ServerID != srv.ID {
		t.Fatalf("evento final: %+v", last)
	}
	if last.Error != "" || last.Cancelled || !last.Done || last.Status != "success" || last.Percent != 100 || last.Completed != 1000 || last.Total != 1000 {
		t.Fatalf("debería terminar bien: %+v", last)
	}
	col.mu.Lock()
	for _, n := range col.names {
		if n != "model-pull:"+id {
			t.Errorf("nombre de evento = %q", n)
		}
	}
	prev := -1.0
	for _, ev := range col.events {
		if ev.Percent < prev {
			t.Errorf("el porcentaje retrocedió: %+v", col.events)
		}
		prev = ev.Percent
	}
	col.mu.Unlock()
	if _, ok := a.modelHealth.get(srv.ID, true); ok {
		t.Error("la descarga debería invalidar el caché de salud")
	}

	// La descarga terminada queda a la vista hasta que se descarte.
	pulls, err := a.ModelServerPulls()
	if err != nil || len(pulls) != 1 || !pulls[0].Done {
		t.Fatalf("pulls = %+v, %v", pulls, err)
	}
	if err := a.ModelServerDismissPull(id); err != nil {
		t.Fatal(err)
	}
	if pulls, _ := a.ModelServerPulls(); len(pulls) != 0 {
		t.Fatalf("después de descartar: %+v", pulls)
	}
}

func TestModelServerPullServerErrorIsReported(t *testing.T) {
	f := &fakeOllamaAdmin{pullLines: []string{`{"error":"pull model manifest: file does not exist"}`}}
	a, srv, _ := adminApp(t, f)
	col := newPullCollector(a)
	if _, err := a.ModelServerPull(srv.ID, "no/existe"); err != nil {
		t.Fatal(err)
	}
	last := col.waitDone(t)
	if !strings.Contains(last.Error, "file does not exist") || last.Cancelled {
		t.Fatalf("debería traer el error del servidor: %+v", last)
	}
}

func TestModelServerPullCancel(t *testing.T) {
	f := &fakeOllamaAdmin{
		pullLines: []string{`{"status":"pulling aaa","digest":"sha256:aaa","total":1000,"completed":10}`},
		block:     make(chan struct{}),
	}
	a, srv, _ := adminApp(t, f)
	defer close(f.block)
	col := newPullCollector(a)

	id, err := a.ModelServerPull(srv.ID, "grande:70b")
	if err != nil {
		t.Fatal(err)
	}
	// La misma descarga dos veces en el mismo servidor no tiene sentido.
	if _, err := a.ModelServerPull(srv.ID, "grande:70b"); err == nil {
		t.Error("una segunda descarga idéntica debería rechazarse")
	}
	// Otro modelo sí, en paralelo.
	id2, err := a.ModelServerPull(srv.ID, "otro:1b")
	if err != nil || id2 == id {
		t.Fatalf("descarga en paralelo: %q, %v", id2, err)
	}
	if err := a.ModelServerCancelPull(id); err != nil {
		t.Fatal(err)
	}
	if err := a.ModelServerCancelPull(id2); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		ev := col.waitDone(t)
		if !ev.Cancelled || ev.Error != "" {
			t.Fatalf("debería quedar cancelada, sin error: %+v", ev)
		}
	}
	if err := a.ModelServerCancelPull(id); err == nil {
		t.Error("cancelar una descarga ya terminada debería fallar")
	}
	if err := a.ModelServerCancelPull("inexistente"); err == nil {
		t.Error("cancelar un id desconocido debería fallar")
	}
	// Ya terminada, se puede volver a pedir (retoma donde quedó).
	if _, err := a.ModelServerPull(srv.ID, "grande:70b"); err != nil {
		t.Errorf("tras cancelar, volver a pedirla debería andar: %v", err)
	}
}

func TestModelServerDeleteModel(t *testing.T) {
	f := &fakeOllamaAdmin{}
	a, srv, _ := adminApp(t, f)
	gen := a.modelHealth.begin(srv.ID)
	a.modelHealth.put(srv.ID, gen, ModelServerProbe{OK: true}, true)

	if err := a.ModelServerDeleteModel(srv.ID, "llama3:8b"); err != nil {
		t.Fatal(err)
	}
	if len(f.deleted) != 1 || f.deleted[0] != "llama3:8b" {
		t.Errorf("borrados: %v", f.deleted)
	}
	if _, ok := a.modelHealth.get(srv.ID, true); ok {
		t.Error("borrar debería invalidar el caché de salud")
	}
	err := a.ModelServerDeleteModel(srv.ID, "fantasma")
	if err == nil || !strings.Contains(err.Error(), "404") {
		t.Fatalf("un 404 debería informarse: %v", err)
	}
}

func TestModelServerOpenAIIsReadOnly(t *testing.T) {
	a, _ := newChatApp(t)
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/models", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"data":[{"id":"phi-4"}]}`)
	})
	ts := httptest.NewServer(mux)
	defer ts.Close()
	srv, err := a.SaveModelServer(ModelServer{Name: "LM Studio", Kind: "openai", BaseURL: ts.URL + "/v1"}, "", false, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	models, err := a.ModelServerModels(srv.ID)
	if err != nil || len(models) != 1 || models[0].Name != "phi-4" {
		t.Fatalf("lista: %+v, %v", models, err)
	}
	if running, err := a.ModelServerRunning(srv.ID); err != nil || len(running) != 0 {
		t.Errorf("cargados en OpenAI: %+v, %v", running, err)
	}
	if _, err := a.ModelServerPull(srv.ID, "phi-4"); !llm.IsUnsupported(err) {
		t.Errorf("pull: %v", err)
	}
	if err := a.ModelServerDeleteModel(srv.ID, "phi-4"); !llm.IsUnsupported(err) {
		t.Errorf("delete: %v", err)
	}
	if _, err := a.ModelServerShowModel(srv.ID, "phi-4"); !llm.IsUnsupported(err) {
		t.Errorf("show: %v", err)
	}
	if err := a.ModelServerUnload(srv.ID, "phi-4"); !llm.IsUnsupported(err) {
		t.Errorf("unload: %v", err)
	}
	if pulls, _ := a.ModelServerPulls(); len(pulls) != 0 {
		t.Errorf("no debería quedar ninguna descarga registrada: %+v", pulls)
	}
}
