package llm

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func newAdmin(t *testing.T, kind string, h http.Handler, opt Options) Admin {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	base := srv.URL
	if kind == KindOpenAI {
		base += "/v1"
	}
	c, err := New(kind, base, opt)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	a, ok := AsAdmin(c)
	if !ok {
		t.Fatalf("el cliente %s debería ser administrable", kind)
	}
	return a
}

func readBody(t *testing.T, r *http.Request) map[string]any {
	t.Helper()
	b, _ := io.ReadAll(r.Body)
	var m map[string]any
	if len(b) > 0 {
		if err := json.Unmarshal(b, &m); err != nil {
			t.Fatalf("cuerpo no es JSON: %q", b)
		}
	}
	return m
}

func TestValidateModelName(t *testing.T) {
	ok := map[string]string{
		"llama3.2":                             "llama3.2",
		"  qwen2.5-coder:7b ":                  "qwen2.5-coder:7b",
		"hf.co/usuario/repo:Q4_K_M":            "hf.co/usuario/repo:Q4_K_M",
		"registro.interno:5000/equipo/mod:1.0": "registro.interno:5000/equipo/mod:1.0",
		"library/gemma3@sha256abc":             "library/gemma3@sha256abc",
	}
	for in, want := range ok {
		got, err := ValidateModelName(in)
		if err != nil || got != want {
			t.Errorf("%q → %q, %v (quería %q)", in, got, err, want)
		}
	}
	bad := []string{"", "   ", "con espacio", "tab\tx", "nueva\nlinea", "x\x00y", "-flag", "/abs", "a//b", "a/../b", "comi\"lla", `back\slash`, strings.Repeat("a", 300)}
	for _, in := range bad {
		if _, err := ValidateModelName(in); err == nil {
			t.Errorf("%q debería rechazarse", in)
		}
	}
}

func TestOllamaListModels(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/tags", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("método %s", r.Method)
		}
		fmt.Fprint(w, `{"models":[
			{"name":"qwen2.5-coder:7b","model":"qwen2.5-coder:7b","modified_at":"2026-03-01T10:00:00-06:00","size":4683087332,"digest":"abc",
			 "details":{"format":"gguf","family":"qwen2","parameter_size":"7.6B","quantization_level":"Q4_K_M"}},
			{"name":"Llama3:latest","size":10},
			{"name":""}]}`)
	})
	a := newAdmin(t, KindOllama, mux, Options{})
	list, err := a.ListModels(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 {
		t.Fatalf("len = %d: %+v", len(list), list)
	}
	// Orden por nombre sin distinguir mayúsculas.
	if list[0].Name != "Llama3:latest" || list[1].Name != "qwen2.5-coder:7b" {
		t.Fatalf("orden: %+v", list)
	}
	q := list[1]
	if q.Size != 4683087332 || q.Family != "qwen2" || q.ParameterSize != "7.6B" || q.QuantizationLevel != "Q4_K_M" ||
		q.Format != "gguf" || q.Digest != "abc" || q.ModifiedAt != "2026-03-01T10:00:00-06:00" {
		t.Fatalf("campos: %+v", q)
	}
}

func TestOllamaRunningModels(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/ps", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"models":[{"name":"llama3:8b","size":6000,"size_vram":5000,"expires_at":"2026-03-01T10:05:00Z","context_length":8192}]}`)
	})
	a := newAdmin(t, KindOllama, mux, Options{})
	list, err := a.RunningModels(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].Name != "llama3:8b" || list[0].SizeVRAM != 5000 || list[0].Size != 6000 ||
		list[0].ExpiresAt != "2026-03-01T10:05:00Z" || list[0].ContextLength != 8192 {
		t.Fatalf("running: %+v", list)
	}
}

func TestOllamaShowModel(t *testing.T) {
	var got map[string]any
	mux := http.NewServeMux()
	mux.HandleFunc("/api/show", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("método %s", r.Method)
		}
		got = readBody(t, r)
		fmt.Fprintf(w, `{"license":%q,"parameters":"stop \"<|im_end|>\"\ntemperature 0.7","template":"{{ .Prompt }}",
			"details":{"format":"gguf","family":"qwen2","parameter_size":"7.6B","quantization_level":"Q4_K_M"},
			"model_info":{"general.architecture":"qwen2","qwen2.context_length":32768,"qwen2.block_count":28},
			"capabilities":["completion","tools"]}`, strings.Repeat("licencia ", 500))
	})
	a := newAdmin(t, KindOllama, mux, Options{})
	d, err := a.ShowModel(context.Background(), "qwen2.5-coder:7b")
	if err != nil {
		t.Fatal(err)
	}
	// Los dos nombres de campo, por los Ollama viejos.
	if got["model"] != "qwen2.5-coder:7b" || got["name"] != "qwen2.5-coder:7b" {
		t.Errorf("cuerpo = %+v", got)
	}
	if d.ContextLength != 32768 || d.Family != "qwen2" || d.Template != "{{ .Prompt }}" ||
		!strings.Contains(d.Parameters, "temperature 0.7") || len(d.Capabilities) != 2 {
		t.Fatalf("detalle: %+v", d)
	}
	if !strings.HasSuffix(d.License, "…") || len([]rune(d.License)) > detailLicenseMax+1 {
		t.Errorf("la licencia debería recortarse: %d runas", len([]rune(d.License)))
	}
}

func TestOllamaShowUnknownModelIs404(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/show", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(404)
		fmt.Fprint(w, `{"error":"model 'nada' not found"}`)
	})
	a := newAdmin(t, KindOllama, mux, Options{})
	_, err := a.ShowModel(context.Background(), "nada")
	var se *StatusError
	if !errors.As(err, &se) || se.Status != 404 || !strings.Contains(se.Msg, "not found") {
		t.Fatalf("err = %v", err)
	}
}

func TestOllamaDeleteModel(t *testing.T) {
	var got map[string]any
	var method string
	mux := http.NewServeMux()
	mux.HandleFunc("/api/delete", func(w http.ResponseWriter, r *http.Request) {
		method = r.Method
		got = readBody(t, r)
		if got["model"] == "ya-no-esta" {
			w.WriteHeader(404)
			fmt.Fprint(w, `{"error":"model 'ya-no-esta' not found"}`)
			return
		}
		w.WriteHeader(200)
	})
	a := newAdmin(t, KindOllama, mux, Options{})
	if err := a.DeleteModel(context.Background(), "llama3:8b"); err != nil {
		t.Fatal(err)
	}
	if method != http.MethodDelete || got["model"] != "llama3:8b" || got["name"] != "llama3:8b" {
		t.Errorf("método %s, cuerpo %+v", method, got)
	}
	err := a.DeleteModel(context.Background(), "ya-no-esta")
	var se *StatusError
	if !errors.As(err, &se) || se.Status != 404 {
		t.Fatalf("un 404 debería ser StatusError: %v", err)
	}
}

func TestOllamaUnloadModel(t *testing.T) {
	var got map[string]any
	mux := http.NewServeMux()
	mux.HandleFunc("/api/generate", func(w http.ResponseWriter, r *http.Request) {
		got = readBody(t, r)
		fmt.Fprint(w, `{"model":"llama3:8b","done":true,"done_reason":"unload"}`)
	})
	a := newAdmin(t, KindOllama, mux, Options{})
	if err := a.UnloadModel(context.Background(), "llama3:8b"); err != nil {
		t.Fatal(err)
	}
	if got["model"] != "llama3:8b" || got["keep_alive"] != float64(0) {
		t.Errorf("cuerpo = %+v", got)
	}
	if _, has := got["prompt"]; has {
		t.Error("no debería mandar prompt: cargaría el modelo en vez de soltarlo")
	}
}

func pullHandler(lines []string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/pull", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/x-ndjson")
		for _, l := range lines {
			fmt.Fprintln(w, l)
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
		}
	})
	return mux
}

func TestOllamaPullStreamsProgress(t *testing.T) {
	a := newAdmin(t, KindOllama, pullHandler([]string{
		`{"status":"pulling manifest"}`,
		`{"status":"pulling aaa","digest":"sha256:aaa","total":1000,"completed":0}`,
		`{"status":"pulling aaa","digest":"sha256:aaa","total":1000,"completed":400}`,
		``,
		`{"status":"pulling bbb","digest":"sha256:bbb","total":100,"completed":100}`,
		`{"status":"pulling aaa","digest":"sha256:aaa","total":1000,"completed":1000}`,
		`{"status":"verifying sha256 digest"}`,
		`{"status":"success"}`,
	}), Options{})
	var seen []PullProgress
	var tr PullTracker
	var pcts []float64
	err := a.PullModel(context.Background(), "tiny:1b", func(p PullProgress) {
		seen = append(seen, p)
		_, _, pct := tr.Update(p)
		pcts = append(pcts, pct)
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(seen) != 7 || seen[0].Status != "pulling manifest" || seen[len(seen)-1].Status != "success" {
		t.Fatalf("progreso: %+v", seen)
	}
	if seen[2].Completed != 400 || seen[2].Total != 1000 || seen[2].Digest != "sha256:aaa" {
		t.Errorf("línea 3: %+v", seen[2])
	}
	for i := 1; i < len(pcts); i++ {
		if pcts[i] < pcts[i-1] {
			t.Errorf("el porcentaje retrocedió en %d: %v", i, pcts)
		}
	}
	if last := pcts[len(pcts)-1]; last != 100 {
		t.Errorf("porcentaje final = %v", last)
	}
}

func TestOllamaPullSendsStreamAndNames(t *testing.T) {
	var got map[string]any
	mux := http.NewServeMux()
	mux.HandleFunc("/api/pull", func(w http.ResponseWriter, r *http.Request) {
		got = readBody(t, r)
		fmt.Fprintln(w, `{"status":"success"}`)
	})
	a := newAdmin(t, KindOllama, mux, Options{})
	if err := a.PullModel(context.Background(), "tiny:1b", nil); err != nil {
		t.Fatal(err)
	}
	if got["model"] != "tiny:1b" || got["name"] != "tiny:1b" || got["stream"] != true {
		t.Errorf("cuerpo = %+v", got)
	}
}

func TestOllamaPullErrorLine(t *testing.T) {
	a := newAdmin(t, KindOllama, pullHandler([]string{
		`{"status":"pulling manifest"}`,
		`{"error":"pull model manifest: file does not exist"}`,
	}), Options{})
	err := a.PullModel(context.Background(), "no/existe", nil)
	if err == nil || !strings.Contains(err.Error(), "file does not exist") {
		t.Fatalf("err = %v", err)
	}
}

func TestOllamaPullHTTPError(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/pull", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
		fmt.Fprint(w, `{"error":"unauthorized"}`)
	})
	a := newAdmin(t, KindOllama, mux, Options{})
	err := a.PullModel(context.Background(), "x", nil)
	var se *StatusError
	if !errors.As(err, &se) || se.Status != 401 {
		t.Fatalf("err = %v", err)
	}
}

func TestOllamaPullWithoutSuccessIsEnded(t *testing.T) {
	a := newAdmin(t, KindOllama, pullHandler([]string{`{"status":"pulling manifest"}`}), Options{})
	err := a.PullModel(context.Background(), "x", nil)
	var ce *ConnError
	if !errors.As(err, &ce) || ce.Kind != ConnEnded {
		t.Fatalf("un stream sin «success» debería ser ConnEnded: %v", err)
	}
}

// Cancelar el contexto corta la descarga en curso: PullModel devuelve
// context.Canceled y el servidor ve cerrarse la conexión.
func TestOllamaPullCancel(t *testing.T) {
	started := make(chan struct{})
	closed := make(chan struct{})
	var once sync.Once
	mux := http.NewServeMux()
	mux.HandleFunc("/api/pull", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintln(w, `{"status":"pulling aaa","digest":"sha256:aaa","total":1000,"completed":10}`)
		w.(http.Flusher).Flush()
		once.Do(func() { close(started) })
		<-r.Context().Done()
		close(closed)
	})
	a := newAdmin(t, KindOllama, mux, Options{})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- a.PullModel(ctx, "grande:70b", nil) }()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("el pull no arrancó")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("err = %v, quería context.Canceled", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("cancelar no cortó el pull")
	}
	select {
	case <-closed:
	case <-time.After(5 * time.Second):
		t.Fatal("el servidor no vio cerrarse la conexión")
	}
}

// La administración usa el mismo requester que el chat: token y cabeceras
// propias viajan en cada llamada.
func TestAdminSendsTokenAndHeaders(t *testing.T) {
	var mu sync.Mutex
	var seen []http.Header
	mux := http.NewServeMux()
	rec := func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, r.Header.Clone())
		mu.Unlock()
		fmt.Fprint(w, `{"models":[]}`)
	}
	mux.HandleFunc("/api/tags", rec)
	mux.HandleFunc("/api/ps", rec)
	a := newAdmin(t, KindOllama, mux, Options{Token: "sk-1", Headers: map[string]string{"X-Api-Key": "k"}})
	if _, err := a.ListModels(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := a.RunningModels(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(seen) != 2 {
		t.Fatalf("llamadas = %d", len(seen))
	}
	for _, h := range seen {
		if h.Get("Authorization") != "Bearer sk-1" || h.Get("X-Api-Key") != "k" {
			t.Errorf("cabeceras: %+v", h)
		}
	}
}

func TestOpenAIListOnly(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/models", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"data":[{"id":"phi-4","created":1700000000},{"id":"Gemma"},{"id":""}]}`)
	})
	a := newAdmin(t, KindOpenAI, mux, Options{})
	list, err := a.ListModels(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 || list[0].Name != "Gemma" || list[1].Name != "phi-4" || list[1].ModifiedAt != "2023-11-14T22:13:20Z" || list[0].ModifiedAt != "" {
		t.Fatalf("lista: %+v", list)
	}
}

func TestOpenAIUnsupportedActions(t *testing.T) {
	a := newAdmin(t, KindOpenAI, http.NotFoundHandler(), Options{})
	ctx := context.Background()
	checks := map[string]error{}
	_, checks["running"] = a.RunningModels(ctx)
	_, checks["show"] = a.ShowModel(ctx, "x")
	checks["pull"] = a.PullModel(ctx, "x", nil)
	checks["delete"] = a.DeleteModel(ctx, "x")
	checks["unload"] = a.UnloadModel(ctx, "x")
	for name, err := range checks {
		if err == nil || !IsUnsupported(err) {
			t.Errorf("%s: debería ser «no soportado»: %v", name, err)
			continue
		}
		if !strings.Contains(err.Error(), "herramienta del propio servidor") {
			t.Errorf("%s: el mensaje no orienta al usuario: %v", name, err)
		}
	}
	if IsUnsupported(errors.New("otro")) || IsUnsupported(nil) {
		t.Error("IsUnsupported debería ser false para otros errores")
	}
}

func TestPullTrackerNeverGoesBack(t *testing.T) {
	var tr PullTracker
	c, tot, pct := tr.Update(PullProgress{Status: "pulling manifest"})
	if c != 0 || tot != 0 || pct != 0 {
		t.Fatalf("sin capas: %d %d %v", c, tot, pct)
	}
	_, _, p1 := tr.Update(PullProgress{Digest: "a", Total: 1000, Completed: 900})
	// Aparece una capa chica sin avance: la fracción caería de 90% a ~82%.
	_, tot, p2 := tr.Update(PullProgress{Digest: "b", Total: 200, Completed: 0})
	if tot != 1200 || p2 < p1 {
		t.Errorf("total %d, %v → %v: no debería retroceder", tot, p1, p2)
	}
}
