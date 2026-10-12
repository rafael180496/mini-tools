package llm

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"mini-tools/backend/i18n"
)

func TestMain(m *testing.M) {
	i18n.SetLang("es")
	os.Exit(m.Run())
}

func newTestClient(t *testing.T, kind string, h http.Handler, token string) Client {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	base := srv.URL
	if kind == KindOpenAI {
		base += "/v1"
	}
	c, err := New(kind, base, Options{Token: token})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return c
}

func TestNormalizeBaseURL(t *testing.T) {
	got, err := NormalizeBaseURL(" http://localhost:11434/ ")
	if err != nil || got != "http://localhost:11434" {
		t.Fatalf("got %q, %v", got, err)
	}
	for _, bad := range []string{"", "localhost:11434", "ftp://x", "http://"} {
		if _, err := NormalizeBaseURL(bad); err == nil {
			t.Errorf("%q debería rechazarse", bad)
		}
	}
	if _, err := New("otro", "http://x", Options{}); err == nil {
		t.Error("un tipo desconocido debería rechazarse")
	}
}

// --- Ollama ---------------------------------------------------------------

func ollamaHandler(t *testing.T, onChat func(body map[string]any)) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/version", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"version":"0.9.1"}`)
	})
	mux.HandleFunc("/api/tags", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"models":[{"name":"qwen2.5:3b"},{"name":"llama3.2:1b"}]}`)
	})
	mux.HandleFunc("/api/chat", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if onChat != nil {
			onChat(body)
		}
		for _, l := range []string{
			`{"model":"qwen2.5:3b","message":{"role":"assistant","content":"","thinking":"pienso"},"done":false}`,
			`{"model":"qwen2.5:3b","message":{"role":"assistant","content":"Ho"},"done":false}`,
			`{"model":"qwen2.5:3b","message":{"role":"assistant","content":"la"},"done":false}`,
			`{"model":"qwen2.5:3b","message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"read_file","arguments":{"path":"a.go"}}}]},"done":false}`,
			`{"model":"qwen2.5:3b","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":12,"eval_count":5}`,
		} {
			fmt.Fprintln(w, l)
		}
	})
	return mux
}

func TestOllamaVersionAndModels(t *testing.T) {
	c := newTestClient(t, KindOllama, ollamaHandler(t, nil), "")
	v, err := c.Version(context.Background())
	if err != nil || v != "0.9.1" {
		t.Fatalf("Version = %q, %v", v, err)
	}
	models, err := c.Models(context.Background())
	if err != nil || len(models) != 2 || models[0] != "qwen2.5:3b" {
		t.Fatalf("Models = %v, %v", models, err)
	}
}

func TestOllamaChatStreams(t *testing.T) {
	img := filepath.Join(t.TempDir(), "p.png")
	// Cabecera PNG mínima: alcanza para que DetectContentType diga image/png.
	if err := os.WriteFile(img, []byte("\x89PNG\r\n\x1a\n0000"), 0o600); err != nil {
		t.Fatal(err)
	}
	var sent map[string]any
	c := newTestClient(t, KindOllama, ollamaHandler(t, func(b map[string]any) { sent = b }), "")

	var text, think strings.Builder
	res, err := c.Chat(context.Background(), ChatRequest{
		Model: "qwen2.5:3b",
		Messages: []Message{
			{Role: RoleSystem, Content: "sé breve"},
			{Role: RoleUser, Content: "hola", Images: []string{img}},
		},
		Tools: []ToolDef{{Name: "read_file", Description: "lee", Parameters: map[string]any{"type": "object"}}},
	}, func(d Delta) { text.WriteString(d.Text); think.WriteString(d.Thinking) })
	if err != nil {
		t.Fatalf("Chat: %v", err)
	}
	if text.String() != "Hola" || think.String() != "pienso" {
		t.Errorf("deltas: text=%q thinking=%q", text.String(), think.String())
	}
	if res.Message.Content != "Hola" || res.Usage.Input != 12 || res.Usage.Output != 5 || res.Model != "qwen2.5:3b" {
		t.Errorf("result = %+v", res)
	}
	if len(res.Message.ToolCalls) != 1 || res.Message.ToolCalls[0].Name != "read_file" || res.Message.ToolCalls[0].Arguments["path"] != "a.go" {
		t.Errorf("tool calls = %+v", res.Message.ToolCalls)
	}

	if sent["stream"] != true {
		t.Errorf("stream = %v", sent["stream"])
	}
	msgs := sent["messages"].([]any)
	user := msgs[1].(map[string]any)
	if imgs, _ := user["images"].([]any); len(imgs) != 1 {
		t.Errorf("la imagen no viajó en base64: %v", user)
	}
	if tools, _ := sent["tools"].([]any); len(tools) != 1 {
		t.Errorf("tools = %v", sent["tools"])
	}
}

func TestOllamaErrors(t *testing.T) {
	c := newTestClient(t, KindOllama, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		fmt.Fprint(w, `{"error":"model 'x' not found"}`)
	}), "")
	_, err := c.Chat(context.Background(), ChatRequest{Model: "x", Messages: []Message{{Role: RoleUser, Content: "hi"}}}, nil)
	if err == nil || !strings.Contains(err.Error(), "404") || !strings.Contains(err.Error(), "model 'x' not found") {
		t.Fatalf("error = %v", err)
	}

	// Error en mitad del stream.
	c = newTestClient(t, KindOllama, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintln(w, `{"error":"se acabó la memoria"}`)
	}), "")
	_, err = c.Chat(context.Background(), ChatRequest{Model: "x", Messages: []Message{{Role: RoleUser, Content: "hi"}}}, nil)
	if err == nil || !strings.Contains(err.Error(), "se acabó la memoria") {
		t.Fatalf("error de stream = %v", err)
	}

	// Stream que se corta sin done.
	c = newTestClient(t, KindOllama, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintln(w, `{"message":{"content":"a"},"done":false}`)
	}), "")
	_, err = c.Chat(context.Background(), ChatRequest{Model: "x", Messages: []Message{{Role: RoleUser, Content: "hi"}}}, nil)
	if err == nil {
		t.Fatal("un stream sin done debería ser error")
	}
}

func TestConnectionRefused(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	url := srv.URL
	srv.Close()
	c, _ := New(KindOllama, url, Options{})
	_, err := c.Version(context.Background())
	if err == nil || !strings.Contains(err.Error(), "no se pudo conectar a "+url) {
		t.Fatalf("error = %v", err)
	}
}

func TestCancelledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	c := newTestClient(t, KindOllama, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Hay que leer el cuerpo para que el servidor vigile la conexión y
		// se entere de que el cliente cortó.
		_, _ = io.Copy(io.Discard, r.Body)
		cancel()
		<-r.Context().Done()
	}), "")
	_, err := c.Chat(ctx, ChatRequest{Model: "x", Messages: []Message{{Role: RoleUser, Content: "hi"}}}, nil)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, quería context.Canceled", err)
	}
}

// --- OpenAI ---------------------------------------------------------------

func openaiHandler(t *testing.T, gotAuth *string, onChat func(body map[string]any)) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/models", func(w http.ResponseWriter, r *http.Request) {
		if gotAuth != nil {
			*gotAuth = r.Header.Get("Authorization")
		}
		fmt.Fprint(w, `{"object":"list","data":[{"id":"qwen2.5-7b"},{"id":"gemma"}]}`)
	})
	mux.HandleFunc("/v1/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if onChat != nil {
			onChat(body)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		for _, l := range []string{
			`: keep-alive`,
			`data: {"model":"qwen2.5-7b","choices":[{"delta":{"role":"assistant","reasoning_content":"pienso"}}]}`,
			``,
			`data: {"choices":[{"delta":{"content":"Ho"}}]}`,
			`data: {"choices":[{"delta":{"content":"la"}}]}`,
			`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"read_file","arguments":"{\"pa"}}]}}]}`,
			`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\":\"a.go\"}"}}]}}]}`,
			`data: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":7}}`,
			`data: [DONE]`,
		} {
			fmt.Fprintln(w, l)
		}
	})
	return mux
}

func TestOpenAIVersionAndModels(t *testing.T) {
	var auth string
	c := newTestClient(t, KindOpenAI, openaiHandler(t, &auth, nil), "sk-secreto")
	if v, err := c.Version(context.Background()); err != nil || v != "" {
		t.Fatalf("Version = %q, %v", v, err)
	}
	models, err := c.Models(context.Background())
	if err != nil || len(models) != 2 || models[0] != "qwen2.5-7b" {
		t.Fatalf("Models = %v, %v", models, err)
	}
	if auth != "Bearer sk-secreto" {
		t.Errorf("Authorization = %q", auth)
	}
}

func TestOpenAIChatStreams(t *testing.T) {
	img := filepath.Join(t.TempDir(), "p.png")
	if err := os.WriteFile(img, []byte("\x89PNG\r\n\x1a\n0000"), 0o600); err != nil {
		t.Fatal(err)
	}
	var sent map[string]any
	c := newTestClient(t, KindOpenAI, openaiHandler(t, nil, func(b map[string]any) { sent = b }), "")

	var text, think strings.Builder
	res, err := c.Chat(context.Background(), ChatRequest{
		Model: "qwen2.5-7b",
		Messages: []Message{
			{Role: RoleSystem, Content: "sé breve"},
			{Role: RoleUser, Content: "mirá", Images: []string{img}},
			{Role: RoleAssistant, ToolCalls: []ToolCall{{ID: "c0", Name: "list_dir", Arguments: map[string]any{"path": "."}}}},
			{Role: RoleTool, ToolCallID: "c0", Name: "list_dir", Content: "a.go"},
		},
	}, func(d Delta) { text.WriteString(d.Text); think.WriteString(d.Thinking) })
	if err != nil {
		t.Fatalf("Chat: %v", err)
	}
	if text.String() != "Hola" || think.String() != "pienso" {
		t.Errorf("deltas: text=%q thinking=%q", text.String(), think.String())
	}
	if res.Message.Content != "Hola" || res.Usage.Input != 20 || res.Usage.Output != 7 || res.Model != "qwen2.5-7b" {
		t.Errorf("result = %+v", res)
	}
	if len(res.Message.ToolCalls) != 1 || res.Message.ToolCalls[0].ID != "c1" || res.Message.ToolCalls[0].Arguments["path"] != "a.go" {
		t.Errorf("tool calls = %+v", res.Message.ToolCalls)
	}

	if sent["stream"] != true {
		t.Errorf("stream = %v", sent["stream"])
	}
	if so, _ := sent["stream_options"].(map[string]any); so["include_usage"] != true {
		t.Errorf("stream_options = %v", sent["stream_options"])
	}
	msgs := sent["messages"].([]any)
	parts, ok := msgs[1].(map[string]any)["content"].([]any)
	if !ok || len(parts) != 2 {
		t.Fatalf("la imagen no viajó como partes: %v", msgs[1])
	}
	url := parts[1].(map[string]any)["image_url"].(map[string]any)["url"].(string)
	if !strings.HasPrefix(url, "data:image/png;base64,") {
		t.Errorf("image_url = %q", url)
	}
	asst := msgs[2].(map[string]any)
	if asst["content"] != nil {
		t.Errorf("un assistant solo con tool_calls debe llevar content null: %v", asst["content"])
	}
	tc := asst["tool_calls"].([]any)[0].(map[string]any)["function"].(map[string]any)
	if tc["arguments"] != `{"path":"."}` {
		t.Errorf("arguments = %v", tc["arguments"])
	}
	if msgs[3].(map[string]any)["tool_call_id"] != "c0" {
		t.Errorf("tool_call_id = %v", msgs[3])
	}
}

func TestOpenAIErrors(t *testing.T) {
	c := newTestClient(t, KindOpenAI, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprint(w, `{"error":{"message":"Incorrect API key","type":"invalid_request_error"}}`)
	}), "mala")
	_, err := c.Models(context.Background())
	if err == nil || !strings.Contains(err.Error(), "401") || !strings.Contains(err.Error(), "Incorrect API key") {
		t.Fatalf("Models error = %v", err)
	}
	_, err = c.Chat(context.Background(), ChatRequest{Model: "x", Messages: []Message{{Role: RoleUser, Content: "hi"}}}, nil)
	if err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("Chat error = %v", err)
	}

	// Cuerpo que no es JSON: se muestra recortado.
	c = newTestClient(t, KindOpenAI, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		fmt.Fprint(w, strings.Repeat("x", 1000))
	}), "")
	_, err = c.Models(context.Background())
	if err == nil || !strings.Contains(err.Error(), "502") || len(err.Error()) > 500 {
		t.Fatalf("error = %v", err)
	}

	// Error dentro del stream.
	c = newTestClient(t, KindOpenAI, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintln(w, `data: {"error":{"message":"context length exceeded"}}`)
	}), "")
	_, err = c.Chat(context.Background(), ChatRequest{Model: "x", Messages: []Message{{Role: RoleUser, Content: "hi"}}}, nil)
	if err == nil || !strings.Contains(err.Error(), "context length exceeded") {
		t.Fatalf("stream error = %v", err)
	}
}

func TestIsToolsUnsupported(t *testing.T) {
	yes := []error{
		&StatusError{Base: "http://x", Status: 400, Msg: "registry.ollama.ai/library/gemma:2b does not support tools"},
		&StatusError{Base: "http://x", Status: 400, Msg: `"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set`},
		&StatusError{Base: "http://x", Status: 500, Msg: "tools param requires --jinja flag"},
		&StatusError{Base: "http://x", Status: 422, Msg: "Function calling is not supported by this model; tools unsupported"},
		fmt.Errorf("el servidor x respondió con un error: model does not support tools"),
	}
	for _, e := range yes {
		if !IsToolsUnsupported(e) {
			t.Errorf("debería ser «no soporta herramientas»: %v", e)
		}
	}
	no := []error{
		nil,
		&StatusError{Base: "http://x", Status: 401, Msg: "tools are not supported for this key"},
		&StatusError{Base: "http://x", Status: 400, Msg: "context length exceeded"},
		&StatusError{Base: "http://x", Status: 404, Msg: "model not found"},
		errors.New("no se pudo conectar a http://x: la conexión fue rechazada"),
	}
	for _, e := range no {
		if IsToolsUnsupported(e) {
			t.Errorf("no debería ser «no soporta herramientas»: %v", e)
		}
	}
}

// El servidor rechaza el request con las herramientas: el error del cliente
// tiene que reconocerse de punta a punta, tal como llega por HTTP.
func TestOllamaToolsRejectedIsRecognized(t *testing.T) {
	c := newTestClient(t, KindOllama, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		fmt.Fprint(w, `{"error":"registry.ollama.ai/library/gemma:2b does not support tools"}`)
	}), "")
	_, err := c.Chat(context.Background(), ChatRequest{
		Model:    "gemma:2b",
		Messages: []Message{{Role: RoleUser, Content: "hi"}},
		Tools:    []ToolDef{{Name: "t", Parameters: map[string]any{"type": "object"}}},
	}, nil)
	if !IsToolsUnsupported(err) {
		t.Fatalf("err = %v", err)
	}
	var se *StatusError
	if !errors.As(err, &se) || se.Status != 400 {
		t.Fatalf("no es un StatusError 400: %v", err)
	}
}

// Un mensaje assistant con llamadas viaja sin `index` (OpenAI) y con los
// argumentos como cadena; el mensaje tool de Ollama lleva tool_name.
func TestToolMessagesEncoding(t *testing.T) {
	var sent map[string]any
	c := newTestClient(t, KindOpenAI, openaiHandler(t, nil, func(b map[string]any) { sent = b }), "")
	_, err := c.Chat(context.Background(), ChatRequest{Model: "m", Messages: []Message{
		{Role: RoleUser, Content: "x"},
		{Role: RoleAssistant, ToolCalls: []ToolCall{{Name: "read_file", Arguments: map[string]any{"path": "a"}}}},
		{Role: RoleTool, ToolCallID: "call_0", Name: "read_file", Content: "ok"},
	}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	call := sent["messages"].([]any)[1].(map[string]any)["tool_calls"].([]any)[0].(map[string]any)
	if _, has := call["index"]; has {
		t.Errorf("tool_calls del historial no debe llevar index: %v", call)
	}
	if call["id"] != "call_0" || call["type"] != "function" {
		t.Errorf("tool call = %v (el id vacío debe completarse para correlacionar)", call)
	}

	var ollamaSent map[string]any
	oc := newTestClient(t, KindOllama, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&ollamaSent)
		fmt.Fprintln(w, `{"model":"m","message":{"role":"assistant","content":"ok"},"done":true}`)
	}), "")
	_, err = oc.Chat(context.Background(), ChatRequest{Model: "m", Messages: []Message{
		{Role: RoleUser, Content: "x"},
		{Role: RoleAssistant, ToolCalls: []ToolCall{{ID: "call_0", Name: "read_file", Arguments: map[string]any{"path": "a"}}}},
		{Role: RoleTool, ToolCallID: "call_0", Name: "read_file", Content: "ok"},
	}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	msgs := ollamaSent["messages"].([]any)
	if msgs[2].(map[string]any)["tool_name"] != "read_file" {
		t.Errorf("Ollama correlaciona por tool_name: %v", msgs[2])
	}
	args := msgs[1].(map[string]any)["tool_calls"].([]any)[0].(map[string]any)["function"].(map[string]any)["arguments"]
	if _, ok := args.(map[string]any); !ok {
		t.Errorf("Ollama espera arguments como objeto, llegó %T", args)
	}
}

// Servidores que no mandan `index`: dos llamadas distintas no se funden en una.
func TestOpenAIToolCallsWithoutIndex(t *testing.T) {
	c := newTestClient(t, KindOpenAI, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintln(w, `data: {"choices":[{"delta":{"tool_calls":[{"id":"a","function":{"name":"f","arguments":"{\"x\":1}"}}]}}]}`)
		fmt.Fprintln(w, `data: {"choices":[{"delta":{"tool_calls":[{"id":"b","function":{"name":"g","arguments":"{\"y\":2}"}}]}}]}`)
		fmt.Fprintln(w, `data: [DONE]`)
	}), "")
	res, err := c.Chat(context.Background(), ChatRequest{Model: "m", Messages: []Message{{Role: RoleUser, Content: "x"}}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	calls := res.Message.ToolCalls
	if len(calls) != 2 || calls[0].Name != "f" || calls[1].Name != "g" || calls[1].Arguments["y"] != float64(2) {
		t.Fatalf("calls = %+v", calls)
	}
}

// --- Cabeceras propias, TLS y clasificación de fallos ------------------------

// Las cabeceras propias viajan en TODO request: versión, modelos y chat, en
// los dos protocolos. El token sigue yendo como Bearer.
func TestCustomHeadersOnEveryRequest(t *testing.T) {
	for _, kind := range []string{KindOllama, KindOpenAI} {
		var mu sync.Mutex
		seen := map[string]http.Header{}
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			mu.Lock()
			seen[r.URL.Path] = r.Header.Clone()
			mu.Unlock()
			switch r.URL.Path {
			case "/api/version":
				fmt.Fprint(w, `{"version":"1"}`)
			case "/api/tags":
				fmt.Fprint(w, `{"models":[{"name":"m"}]}`)
			case "/api/chat":
				fmt.Fprintln(w, `{"message":{"content":"ok"},"done":true}`)
			case "/v1/models":
				fmt.Fprint(w, `{"data":[{"id":"m"}]}`)
			case "/v1/chat/completions":
				fmt.Fprintln(w, `data: {"choices":[{"delta":{"content":"ok"}}]}`)
				fmt.Fprintln(w, `data: [DONE]`)
			}
		}))
		base := srv.URL
		if kind == KindOpenAI {
			base += "/v1"
		}
		c, err := New(kind, base, Options{Token: "tok", Headers: map[string]string{"X-Api-Key": "k1", "CF-Access-Client-Id": "id"}})
		if err != nil {
			t.Fatal(err)
		}
		ctx := context.Background()
		if _, err := c.Version(ctx); err != nil {
			t.Fatal(err)
		}
		if _, err := c.Models(ctx); err != nil {
			t.Fatal(err)
		}
		if _, err := c.Chat(ctx, ChatRequest{Model: "m", Messages: []Message{{Role: RoleUser, Content: "hi"}}}, nil); err != nil {
			t.Fatal(err)
		}
		srv.Close()
		mu.Lock()
		for path, h := range seen {
			if h.Get("X-Api-Key") != "k1" || h.Get("CF-Access-Client-Id") != "id" || h.Get("Authorization") != "Bearer tok" {
				t.Errorf("%s %s: cabeceras = %v", kind, path, h)
			}
		}
		if len(seen) < 2 {
			t.Errorf("%s: se esperaban al menos 2 rutas, hubo %d", kind, len(seen))
		}
		mu.Unlock()
	}
}

// Un certificado que no está en la cadena de confianza da un error claro que
// sugiere la opción; con InsecureTLS encendida el mismo servidor funciona.
func TestInsecureTLS(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"version":"0.9"}`)
	}))
	defer srv.Close()

	strict, _ := New(KindOllama, srv.URL, Options{})
	_, err := strict.Version(context.Background())
	if err == nil || !IsTLSError(err) {
		t.Fatalf("debería fallar por certificado: %v", err)
	}
	if !strings.Contains(err.Error(), "Aceptar certificado autofirmado") || !strings.Contains(err.Error(), "certificado no confiable") {
		t.Errorf("el mensaje debería sugerir la opción: %v", err)
	}
	if IsRetryable(err) {
		t.Error("un error de certificado no se reintenta")
	}

	loose, _ := New(KindOllama, srv.URL, Options{InsecureTLS: true})
	v, err := loose.Version(context.Background())
	if err != nil || v != "0.9" {
		t.Fatalf("con InsecureTLS debería conectar: %q, %v", v, err)
	}
}

// Con la opción ya encendida, un fallo TLS no vuelve a sugerirla.
func TestTLSErrorDoesNotSuggestOptionWhenOn(t *testing.T) {
	e := &ConnError{Base: "https://x", Kind: ConnTLS, Err: x509.UnknownAuthorityError{}, InsecureTLS: true}
	if strings.Contains(e.Error(), "autofirmado") {
		t.Errorf("no debería sugerir la opción: %v", e)
	}
}

func TestConnErrorKinds(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	url := srv.URL
	srv.Close()
	c, _ := New(KindOllama, url, Options{})
	_, err := c.Version(context.Background())
	var ce *ConnError
	if !errors.As(err, &ce) || ce.Kind != ConnRefused || !IsRetryable(err) {
		t.Fatalf("refused debería ser ConnRefused y reintentable: %#v", err)
	}

	// Un 4xx no es de conexión: no se reintenta.
	se := &StatusError{Base: "http://x", Status: 401, Msg: "no"}
	if IsRetryable(se) || IsRetryable(context.Canceled) || IsRetryable(nil) {
		t.Error("StatusError / Canceled / nil no son reintentables")
	}
	// Un corte con EOF sí; un corte de lectura cualquiera, no.
	if !IsRetryable(interruptedError("http://x", io.ErrUnexpectedEOF)) {
		t.Error("EOF debería ser reintentable")
	}
	if IsRetryable(interruptedError("http://x", errors.New("bufio.Scanner: token too long"))) {
		t.Error("un corte de lectura cualquiera no es reintentable")
	}
}

// Un servidor que cierra la conexión sin contestar es un corte reintentable.
func TestServerClosingConnectionIsReset(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hj, _ := w.(http.Hijacker)
		conn, _, _ := hj.Hijack()
		conn.Close()
	}))
	defer srv.Close()
	c, _ := New(KindOllama, srv.URL, Options{})
	_, err := c.Chat(context.Background(), ChatRequest{Model: "m", Messages: []Message{{Role: RoleUser, Content: "x"}}}, nil)
	if !IsRetryable(err) {
		t.Fatalf("err = %v, debería ser reintentable", err)
	}
}

// options.num_ctx viaja solo con Ollama y solo si hay una ventana configurada.
func TestOllamaSendsNumCtxOnlyWhenSet(t *testing.T) {
	chat := func(ctxTokens int) map[string]any {
		var sent map[string]any
		srv := httptest.NewServer(ollamaHandler(t, func(b map[string]any) { sent = b }))
		defer srv.Close()
		c, err := New(KindOllama, srv.URL, Options{ContextTokens: ctxTokens})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := c.Chat(context.Background(), ChatRequest{Model: "m", Messages: []Message{{Role: RoleUser, Content: "hola"}}}, nil); err != nil {
			t.Fatalf("Chat: %v", err)
		}
		return sent
	}

	with := chat(16384)
	opts, _ := with["options"].(map[string]any)
	if opts["num_ctx"] != float64(16384) {
		t.Errorf("options = %v, debía llevar num_ctx 16384", with["options"])
	}
	if _, has := chat(0)["options"]; has {
		t.Error("con 0 no debe mandarse options: el servidor usa la suya")
	}
}

// Un servidor OpenAI no admite la ventana por petición: aunque la opción
// llegue, no viaja nada parecido a num_ctx.
func TestOpenAIIgnoresContextTokens(t *testing.T) {
	var sent map[string]any
	srv := httptest.NewServer(openaiHandler(t, new(string), func(b map[string]any) { sent = b }))
	defer srv.Close()
	c, err := New(KindOpenAI, srv.URL+"/v1", Options{ContextTokens: 16384})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Chat(context.Background(), ChatRequest{Model: "m", Messages: []Message{{Role: RoleUser, Content: "hola"}}}, nil); err != nil {
		t.Fatalf("Chat: %v", err)
	}
	raw, _ := json.Marshal(sent)
	if strings.Contains(string(raw), "num_ctx") {
		t.Errorf("el request OpenAI no debe llevar la ventana: %s", raw)
	}
}
