package llm

import (
	"context"
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
)

// --- Servidor falso de la Messages API ---------------------------------------

func sse(typ, data string) string { return "event: " + typ + "\ndata: " + data + "\n\n" }

func msgStart(usage string) string {
	return sse("message_start", `{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-opus-5-5","content":[],"stop_reason":null,"stop_sequence":null,"usage":`+usage+`}}`)
}

func blockStart(idx int, block string) string {
	return sse("content_block_start", fmt.Sprintf(`{"type":"content_block_start","index":%d,"content_block":%s}`, idx, block))
}

func blockDelta(idx int, delta string) string {
	return sse("content_block_delta", fmt.Sprintf(`{"type":"content_block_delta","index":%d,"delta":%s}`, idx, delta))
}

func blockStop(idx int) string {
	return sse("content_block_stop", fmt.Sprintf(`{"type":"content_block_stop","index":%d}`, idx))
}

func msgEnd(stop, details string, outTokens int) string {
	if details == "" {
		details = "null"
	}
	return sse("message_delta", fmt.Sprintf(`{"type":"message_delta","delta":{"stop_reason":%q,"stop_sequence":null,"stop_details":%s},"usage":{"output_tokens":%d}}`, stop, details, outTokens)) +
		sse("message_stop", `{"type":"message_stop"}`)
}

const defaultUsage = `{"input_tokens":25,"cache_creation_input_tokens":10,"cache_read_input_tokens":100,"output_tokens":1}`

func textBlock(idx int, text string) string {
	return blockStart(idx, `{"type":"text","text":""}`) +
		blockDelta(idx, `{"type":"text_delta","text":`+jsonStr(text)+`}`) + blockStop(idx)
}

func thinkingBlock(idx int, thinking, sig string) string {
	return blockStart(idx, `{"type":"thinking","thinking":"","signature":""}`) +
		blockDelta(idx, `{"type":"thinking_delta","thinking":`+jsonStr(thinking)+`}`) +
		blockDelta(idx, `{"type":"signature_delta","signature":`+jsonStr(sig)+`}`) + blockStop(idx)
}

// toolBlock parte el JSON de los argumentos en dos trozos, como el stream real.
func toolBlock(idx int, id, name, args string) string {
	half := len(args) / 2
	return blockStart(idx, fmt.Sprintf(`{"type":"tool_use","id":%q,"name":%q,"input":{}}`, id, name)) +
		blockDelta(idx, `{"type":"input_json_delta","partial_json":`+jsonStr(args[:half])+`}`) +
		blockDelta(idx, `{"type":"input_json_delta","partial_json":`+jsonStr(args[half:])+`}`) + blockStop(idx)
}

func jsonStr(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

// fakeAnthropic emula /v1/models, /v1/models/{id} y /v1/messages. Cada POST a
// /v1/messages contesta con el siguiente stream de `streams` y guarda el cuerpo.
type fakeAnthropic struct {
	mu      sync.Mutex
	streams []string
	bodies  []map[string]any
	headers []http.Header
	// caps es el JSON de GET /v1/models/{id}; "" = 404.
	caps string
	// status, si no es 0, hace que /v1/messages conteste ese error con su cuerpo.
	status  int
	errBody string
	errHdr  map[string]string
	models  string
}

const modernCaps = `{"id":"claude-opus-5-5","type":"model","display_name":"Claude Opus 5.5","created_at":"2026-09-01T00:00:00Z","max_input_tokens":1000000,"max_tokens":128000,
"capabilities":{"thinking":{"supported":true,"types":{"adaptive":{"supported":true},"enabled":{"supported":false},"disabled":{"supported":false}}},
"effort":{"supported":true,"low":{"supported":true},"medium":{"supported":true},"high":{"supported":true},"xhigh":{"supported":true},"max":{"supported":true}}}}`

func (f *fakeAnthropic) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/models/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		f.mu.Lock()
		caps := f.caps
		f.mu.Unlock()
		if caps == "" {
			w.WriteHeader(404)
			fmt.Fprint(w, `{"type":"error","error":{"type":"not_found_error","message":"nope"}}`)
			return
		}
		fmt.Fprint(w, caps)
	})
	mux.HandleFunc("/v1/models", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		f.mu.Lock()
		f.headers = append(f.headers, r.Header.Clone())
		models := f.models
		status, body := f.status, f.errBody
		f.mu.Unlock()
		if status != 0 {
			w.WriteHeader(status)
			fmt.Fprint(w, body)
			return
		}
		if models == "" {
			models = `{"data":[{"id":"claude-opus-5-5","type":"model","display_name":"Claude Opus 5.5","created_at":"2026-09-01T00:00:00Z"},{"id":"claude-sonnet-5-5","type":"model","display_name":"Claude Sonnet 5.5","created_at":"2026-08-01T00:00:00Z"}],"has_more":false,"first_id":"claude-opus-5-5","last_id":"claude-sonnet-5-5"}`
		}
		fmt.Fprint(w, models)
	})
	mux.HandleFunc("/v1/messages", func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		f.mu.Lock()
		f.bodies = append(f.bodies, body)
		f.headers = append(f.headers, r.Header.Clone())
		status, errBody, hdr := f.status, f.errBody, f.errHdr
		var stream string
		if len(f.streams) > 0 {
			stream, f.streams = f.streams[0], f.streams[1:]
		}
		f.mu.Unlock()
		if status != 0 {
			w.Header().Set("Content-Type", "application/json")
			for k, v := range hdr {
				w.Header().Set(k, v)
			}
			w.WriteHeader(status)
			fmt.Fprint(w, errBody)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, stream)
	})
	return mux
}

func newAnthropicTest(t *testing.T, f *fakeAnthropic, opt Options) Client {
	t.Helper()
	srv := httptest.NewServer(f.handler())
	t.Cleanup(srv.Close)
	c, err := New(KindAnthropic, srv.URL, opt)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return c
}

func (f *fakeAnthropic) body(i int) map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	if i >= len(f.bodies) {
		return nil
	}
	return f.bodies[i]
}

func sub(m map[string]any, keys ...string) any {
	var cur any = m
	for _, k := range keys {
		mm, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		cur = mm[k]
	}
	return cur
}

// --- Tests ------------------------------------------------------------------

func TestNormalizeBaseURLForAnthropic(t *testing.T) {
	for in, want := range map[string]string{
		"":                               DefaultAnthropicBaseURL,
		"  ":                             DefaultAnthropicBaseURL,
		"https://api.anthropic.com/":     "https://api.anthropic.com",
		"https://api.anthropic.com/v1":   "https://api.anthropic.com",
		"https://gw.example.com/claude/": "https://gw.example.com/claude",
		"https://gw.example.com/v1/":     "https://gw.example.com",
	} {
		if got := NormalizeBaseURLFor(KindAnthropic, in); got != want {
			t.Errorf("%q -> %q, quería %q", in, got, want)
		}
	}
	if got := NormalizeBaseURLFor(KindOpenAI, "http://x/v1/"); got != "http://x/v1/" {
		t.Errorf("otro tipo no se toca: %q", got)
	}
	// Sin URL, New usa la oficial en vez de fallar.
	if _, err := New(KindAnthropic, "", Options{Token: "k"}); err != nil {
		t.Errorf("URL vacía: %v", err)
	}
}

func TestAnthropicModelsAndVersion(t *testing.T) {
	f := &fakeAnthropic{}
	c := newAnthropicTest(t, f, Options{Token: "sk-test", Headers: map[string]string{"X-Team": "mini"}})
	if v, err := c.Version(context.Background()); v != "" || err != nil {
		t.Errorf("Version = %q, %v", v, err)
	}
	ids, err := c.Models(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(ids, ",") != "claude-opus-5-5,claude-sonnet-5-5" {
		t.Errorf("ids = %v", ids)
	}
	h := f.headers[0]
	if h.Get("x-api-key") != "sk-test" || h.Get("anthropic-version") == "" || h.Get("X-Team") != "mini" {
		t.Errorf("cabeceras: %v", h)
	}
	if h.Get("Authorization") != "" {
		t.Errorf("Anthropic usa x-api-key, no Authorization: %v", h)
	}
	if dm, ok := c.(interface{ DefaultModel() string }); !ok || dm.DefaultModel() != "claude-opus-5-5" {
		t.Error("el cliente debe ofrecer claude-opus-5-5 como modelo por defecto")
	}
}

// El entorno del usuario no se cuela: sin token no se manda ninguna clave, y la
// URL base es la del proveedor.
func TestAnthropicIgnoresEnvironment(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "env-key")
	t.Setenv("ANTHROPIC_AUTH_TOKEN", "env-token")
	t.Setenv("ANTHROPIC_BASE_URL", "http://127.0.0.1:1")
	f := &fakeAnthropic{}
	c := newAnthropicTest(t, f, Options{})
	if _, err := c.Models(context.Background()); err != nil {
		t.Fatal(err)
	}
	h := f.headers[0]
	if h.Get("x-api-key") != "" || h.Get("Authorization") != "" {
		t.Errorf("se coló una credencial del entorno: %v", h)
	}
}

func TestAnthropicChatRequestShapeAndStream(t *testing.T) {
	f := &fakeAnthropic{caps: modernCaps, streams: []string{
		msgStart(defaultUsage) +
			thinkingBlock(0, "pienso", "sig-abc") +
			textBlock(1, "Hola") +
			blockStart(2, `{"type":"text","text":""}`) + blockDelta(2, `{"type":"text_delta","text":" mundo"}`) + blockStop(2) +
			msgEnd("end_turn", "", 42),
	}}
	c := newAnthropicTest(t, f, Options{Token: "k"})
	var deltas []Delta
	res, err := c.Chat(context.Background(), ChatRequest{
		Messages: []Message{{Role: RoleSystem, Content: "Sos un asistente."}, {Role: RoleUser, Content: "hola"}},
		Tools: []ToolDef{
			{Name: "write_file", Description: "escribe", Parameters: map[string]any{"type": "object", "properties": map[string]any{"path": map[string]any{"type": "string"}}, "required": []any{"path"}}},
			{Name: "read_file", Parameters: map[string]any{"type": "object", "properties": map[string]any{"path": map[string]any{"type": "string"}}}},
		},
	}, func(d Delta) { deltas = append(deltas, d) })
	if err != nil {
		t.Fatal(err)
	}

	// Request.
	b := f.body(0)
	if sub(b, "model") != "claude-opus-5-5" {
		t.Errorf("sin modelo debe usar claude-opus-5-5: %v", sub(b, "model"))
	}
	if sub(b, "max_tokens") != float64(64000) || sub(b, "stream") != true {
		t.Errorf("max_tokens/stream: %v %v", sub(b, "max_tokens"), sub(b, "stream"))
	}
	if sub(b, "thinking", "type") != "adaptive" || sub(b, "thinking", "display") != "summarized" {
		t.Errorf("thinking: %v", sub(b, "thinking"))
	}
	if sub(b, "thinking", "budget_tokens") != nil {
		t.Error("budget_tokens está prohibido")
	}
	if sub(b, "output_config", "effort") != "medium" {
		t.Errorf("effort de Opus 5.5 = medium explícito: %v", sub(b, "output_config"))
	}
	for _, k := range []string{"temperature", "top_p", "top_k"} {
		if _, ok := b[k]; ok {
			t.Errorf("%s no debe enviarse", k)
		}
	}
	if sub(b, "tool_choice", "type") != "auto" {
		t.Errorf("tool_choice: %v", sub(b, "tool_choice"))
	}
	if sub(b, "cache_control", "type") != "ephemeral" {
		t.Errorf("falta el cache_control del nivel superior: %v", b["cache_control"])
	}
	sys, _ := b["system"].([]any)
	if len(sys) != 1 || sub(sys[0].(map[string]any), "text") != "Sos un asistente." || sub(sys[0].(map[string]any), "cache_control", "type") != "ephemeral" {
		t.Errorf("system con cache_control: %v", b["system"])
	}
	tools, _ := b["tools"].([]any)
	if len(tools) != 2 || sub(tools[0].(map[string]any), "name") != "read_file" || sub(tools[1].(map[string]any), "name") != "write_file" {
		t.Fatalf("las herramientas van ordenadas por nombre: %v", b["tools"])
	}
	for _, tl := range tools {
		if sub(tl.(map[string]any), "eager_input_streaming") != true || sub(tl.(map[string]any), "input_schema", "type") != "object" {
			t.Errorf("herramienta: %v", tl)
		}
	}
	if sub(tools[1].(map[string]any), "input_schema", "required") == nil {
		t.Errorf("faltan los required: %v", tools[1])
	}
	msgs, _ := b["messages"].([]any)
	if len(msgs) != 1 || sub(msgs[0].(map[string]any), "role") != "user" {
		t.Errorf("messages: %v", b["messages"])
	}

	// Respuesta.
	if res.Message.Content != "Hola mundo" || res.Message.Role != RoleAssistant {
		t.Errorf("mensaje = %+v", res.Message)
	}
	var thinking, text string
	for _, d := range deltas {
		thinking += d.Thinking
		text += d.Text
	}
	if thinking != "pienso" || text != "Hola mundo" {
		t.Errorf("deltas: thinking=%q text=%q", thinking, text)
	}
	// Input incluye lo leído y escrito en caché.
	if res.Usage.Input != 135 || res.Usage.Output != 42 || res.Usage.CacheRead != 100 || res.Usage.CacheWrite != 10 {
		t.Errorf("usage = %+v", res.Usage)
	}
	if res.Model != "claude-opus-5-5" {
		t.Errorf("modelo = %q", res.Model)
	}
	if raw, ok := res.Message.Raw.([]anthropicBlock); !ok || len(raw) != 3 {
		t.Errorf("Raw debe conservar los 3 bloques (thinking + 2 texto): %T %v", res.Message.Raw, res.Message.Raw)
	}
}

func TestAnthropicModelCapabilities(t *testing.T) {
	// Un modelo viejo: sin pensamiento adaptativo ni effort, y con menos salida.
	f := &fakeAnthropic{caps: `{"id":"claude-3-haiku","max_tokens":4096,"capabilities":{"thinking":{"supported":false,"types":{"adaptive":{"supported":false}}},"effort":{"supported":false}}}`,
		streams: []string{msgStart(`{"input_tokens":3,"output_tokens":1}`) + textBlock(0, "ok") + msgEnd("end_turn", "", 2)}}
	c := newAnthropicTest(t, f, Options{})
	if _, err := c.Chat(context.Background(), ChatRequest{Model: "claude-3-haiku", Messages: []Message{{Role: RoleUser, Content: "hola"}}}, nil); err != nil {
		t.Fatal(err)
	}
	b := f.body(0)
	if _, ok := b["thinking"]; ok {
		t.Errorf("un modelo sin pensamiento adaptativo no debe recibir thinking: %v", b["thinking"])
	}
	if _, ok := b["output_config"]; ok {
		t.Errorf("sin soporte de effort no se manda: %v", b["output_config"])
	}
	if sub(b, "max_tokens") != float64(4096) {
		t.Errorf("max_tokens se acota al del modelo: %v", sub(b, "max_tokens"))
	}
	if sub(b, "model") != "claude-3-haiku" {
		t.Errorf("model = %v", sub(b, "model"))
	}
}

// Si la Models API no contesta (un proxy que no la expone), una familia actual
// sigue recibiendo pensamiento adaptativo y effort.
func TestAnthropicCapabilitiesFallback(t *testing.T) {
	f := &fakeAnthropic{streams: []string{msgStart(`{"input_tokens":3,"output_tokens":1}`) + textBlock(0, "ok") + msgEnd("end_turn", "", 2)}}
	c := newAnthropicTest(t, f, Options{})
	if _, err := c.Chat(context.Background(), ChatRequest{Model: "claude-sonnet-5-5", Messages: []Message{{Role: RoleUser, Content: "hola"}}}, nil); err != nil {
		t.Fatal(err)
	}
	b := f.body(0)
	if sub(b, "thinking", "type") != "adaptive" || sub(b, "output_config", "effort") != "high" {
		t.Errorf("fallback: thinking=%v output_config=%v", b["thinking"], b["output_config"])
	}
}

func TestAnthropicToolLoopPreservesThinking(t *testing.T) {
	f := &fakeAnthropic{caps: modernCaps, streams: []string{
		// Vuelta 1: pensamiento + texto + dos llamadas en paralelo.
		msgStart(defaultUsage) + thinkingBlock(0, "debo leer dos archivos", "sig-1") + textBlock(1, "Leo ambos.") +
			toolBlock(2, "toolu_a", "read_file", `{"path":"a.go"}`) + toolBlock(3, "toolu_b", "read_file", `{"path":"b.go"}`) +
			msgEnd("tool_use", "", 60),
		// Vuelta 2: respuesta final.
		msgStart(defaultUsage) + textBlock(0, "Listo.") + msgEnd("end_turn", "", 5),
		// Turno siguiente.
		msgStart(defaultUsage) + textBlock(0, "Otra cosa.") + msgEnd("end_turn", "", 5),
	}}
	c := newAnthropicTest(t, f, Options{Token: "k"})
	tools := []ToolDef{{Name: "read_file", Parameters: map[string]any{"type": "object", "properties": map[string]any{"path": map[string]any{"type": "string"}}, "required": []any{"path"}}}}
	hist := []Message{{Role: RoleSystem, Content: "sys"}, {Role: RoleUser, Content: "leé a y b"}}

	r1, err := c.Chat(context.Background(), ChatRequest{Messages: hist, Tools: tools}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(r1.Message.ToolCalls) != 2 || r1.Message.ToolCalls[0].ID != "toolu_a" || r1.Message.ToolCalls[1].Arguments["path"] != "b.go" {
		t.Fatalf("llamadas = %+v", r1.Message.ToolCalls)
	}

	hist = append(hist, r1.Message,
		Message{Role: RoleTool, ToolCallID: "toolu_a", Name: "read_file", Content: "contenido a"},
		Message{Role: RoleTool, ToolCallID: "toolu_b", Name: "read_file", Content: "error: no existe"})
	r2, err := c.Chat(context.Background(), ChatRequest{Messages: hist, Tools: tools}, nil)
	if err != nil {
		t.Fatal(err)
	}

	// Vuelta 2: el asistente se reenvía con SUS bloques originales (thinking
	// intacto) y los dos resultados van juntos en un solo mensaje de usuario.
	msgs, _ := f.body(1)["messages"].([]any)
	if len(msgs) != 3 {
		t.Fatalf("messages = %d: %v", len(msgs), msgs)
	}
	asst := msgs[1].(map[string]any)["content"].([]any)
	if len(asst) != 4 || sub(asst[0].(map[string]any), "type") != "thinking" || sub(asst[0].(map[string]any), "signature") != "sig-1" || sub(asst[0].(map[string]any), "thinking") != "debo leer dos archivos" {
		t.Errorf("el thinking tiene que volver idéntico: %v", asst)
	}
	if sub(asst[2].(map[string]any), "type") != "tool_use" || sub(asst[2].(map[string]any), "id") != "toolu_a" || sub(asst[3].(map[string]any), "input", "path") != "b.go" {
		t.Errorf("tool_use: %v", asst)
	}
	results := msgs[2].(map[string]any)["content"].([]any)
	if len(results) != 2 || sub(results[0].(map[string]any), "type") != "tool_result" || sub(results[0].(map[string]any), "tool_use_id") != "toolu_a" || sub(results[1].(map[string]any), "is_error") != true {
		t.Errorf("tool_results en un solo mensaje: %v", results)
	}

	// Turno siguiente (otro mensaje del usuario): lo anterior se reenvía SIN
	// pensamiento, aunque Raw siga ahí.
	hist = append(hist, r2.Message, Message{Role: RoleUser, Content: "y ahora otra cosa"})
	if _, err := c.Chat(context.Background(), ChatRequest{Messages: hist, Tools: tools}, nil); err != nil {
		t.Fatal(err)
	}
	b3, _ := json.Marshal(f.body(2)["messages"])
	if strings.Contains(string(b3), `"thinking"`) || strings.Contains(string(b3), "sig-1") {
		t.Errorf("los turnos anteriores no llevan thinking: %s", b3)
	}
	if !strings.Contains(string(b3), "toolu_a") || !strings.Contains(string(b3), "Leo ambos.") {
		t.Errorf("pero sí su texto y sus tool_use: %s", b3)
	}
	msgs3, _ := f.body(2)["messages"].([]any)
	// user, assistant(tool_use), user(2 tool_result), assistant(texto), user.
	if len(msgs3) != 5 {
		t.Errorf("estructura del tercer pedido = %d mensajes", len(msgs3))
	}
}

func TestAnthropicInvalidToolInput(t *testing.T) {
	tools := []ToolDef{{Name: "write_file", Parameters: map[string]any{
		"type": "object", "properties": map[string]any{"path": map[string]any{"type": "string"}, "n": map[string]any{"type": "integer"}}, "required": []any{"path"},
	}}}
	cases := map[string]string{
		"JSON cortado":           `{"path":"a.go","n":`,
		"sin required":           `{"n":3}`,
		"tipo equivocado":        `{"path":"a.go","n":"tres"}`,
		"no es un objeto":        `[1,2]`,
		"entero con decimales":   `{"path":"a.go","n":1.5}`,
		"path no es string":      `{"path":7}`,
		"basura después del fin": `{"path":"a.go"} basura`,
	}
	for name, args := range cases {
		t.Run(name, func(t *testing.T) {
			f := &fakeAnthropic{caps: modernCaps, streams: []string{msgStart(defaultUsage) + toolBlock(0, "toolu_x", "write_file", args) + msgEnd("tool_use", "", 9)}}
			c := newAnthropicTest(t, f, Options{})
			res, err := c.Chat(context.Background(), ChatRequest{Messages: []Message{{Role: RoleUser, Content: "x"}}, Tools: tools}, nil)
			if err != nil {
				t.Fatal(err)
			}
			if len(res.Message.ToolCalls) != 1 {
				t.Fatalf("llamadas = %+v", res.Message.ToolCalls)
			}
			a := res.Message.ToolCalls[0].Arguments
			if raw, _ := a["_raw"].(string); raw != args || len(a) != 1 {
				t.Errorf("tiene que quedar _raw con lo recibido: %v", a)
			}
			// El bloque que se reenvía lleva {} (un JSON válido) para que el
			// historial no rompa el próximo pedido.
			blocks := res.Message.Raw.([]anthropicBlock)
			b, _ := json.Marshal(blocks[0])
			if !strings.Contains(string(b), `"input":{}`) {
				t.Errorf("tool_use reenviado: %s", b)
			}
		})
	}
	// Uno válido sí pasa.
	f := &fakeAnthropic{caps: modernCaps, streams: []string{msgStart(defaultUsage) + toolBlock(0, "toolu_x", "write_file", `{"path":"a.go","n":3}`) + msgEnd("tool_use", "", 9)}}
	c := newAnthropicTest(t, f, Options{})
	res, err := c.Chat(context.Background(), ChatRequest{Messages: []Message{{Role: RoleUser, Content: "x"}}, Tools: tools}, nil)
	if err != nil || res.Message.ToolCalls[0].Arguments["path"] != "a.go" || res.Message.ToolCalls[0].Arguments["n"] != float64(3) {
		t.Errorf("válido: %+v, %v", res.Message.ToolCalls, err)
	}
}

func TestAnthropicStopReasons(t *testing.T) {
	tools := []ToolDef{{Name: "t", Parameters: map[string]any{"type": "object"}}}
	req := ChatRequest{Messages: []Message{{Role: RoleUser, Content: "x"}}, Tools: tools}

	t.Run("refusal", func(t *testing.T) {
		f := &fakeAnthropic{caps: modernCaps, streams: []string{msgStart(defaultUsage) + textBlock(0, "no puedo") +
			msgEnd("refusal", `{"type":"refusal","category":"cyber","explanation":"pedido de malware"}`, 3)}}
		_, err := newAnthropicTest(t, f, Options{}).Chat(context.Background(), req, nil)
		var re *RefusalError
		if !errors.As(err, &re) || re.Category != "cyber" || !strings.Contains(err.Error(), "cyber") || !strings.Contains(err.Error(), "pedido de malware") {
			t.Errorf("err = %v", err)
		}
	})
	t.Run("max_tokens con herramienta a medias", func(t *testing.T) {
		f := &fakeAnthropic{caps: modernCaps, streams: []string{msgStart(defaultUsage) + toolBlock(0, "toolu_x", "t", `{"a":"b"}`) + msgEnd("max_tokens", "", 64000)}}
		_, err := newAnthropicTest(t, f, Options{}).Chat(context.Background(), req, nil)
		var te *TruncatedError
		if !errors.As(err, &te) {
			t.Errorf("err = %v", err)
		}
	})
	t.Run("max_tokens solo texto", func(t *testing.T) {
		f := &fakeAnthropic{caps: modernCaps, streams: []string{msgStart(defaultUsage) + textBlock(0, "texto largo") + msgEnd("max_tokens", "", 64000)}}
		var got string
		res, err := newAnthropicTest(t, f, Options{}).Chat(context.Background(), req, func(d Delta) { got += d.Text })
		if err != nil || !strings.HasPrefix(res.Message.Content, "texto largo") || !strings.Contains(got, "límite de tokens") {
			t.Errorf("res=%+v got=%q err=%v", res.Message, got, err)
		}
	})
	t.Run("pause_turn continúa", func(t *testing.T) {
		f := &fakeAnthropic{caps: modernCaps, streams: []string{
			msgStart(defaultUsage) + textBlock(0, "parte 1. ") + msgEnd("pause_turn", "", 5),
			msgStart(defaultUsage) + textBlock(0, "parte 2.") + msgEnd("end_turn", "", 5),
		}}
		res, err := newAnthropicTest(t, f, Options{}).Chat(context.Background(), req, nil)
		if err != nil || res.Message.Content != "parte 1. parte 2." {
			t.Fatalf("res=%+v err=%v", res.Message, err)
		}
		msgs, _ := f.body(1)["messages"].([]any)
		if len(msgs) != 2 || sub(msgs[1].(map[string]any), "role") != "assistant" {
			t.Errorf("la continuación reenvía lo dicho: %v", msgs)
		}
		if res.Usage.Output != 10 {
			t.Errorf("el uso se suma entre continuaciones: %+v", res.Usage)
		}
	})
}

func TestAnthropicErrors(t *testing.T) {
	req := ChatRequest{Messages: []Message{{Role: RoleUser, Content: "x"}}}
	run := func(f *fakeAnthropic) error {
		f.caps = modernCaps
		_, err := newAnthropicTest(t, f, Options{Token: "k"}).Chat(context.Background(), req, nil)
		return err
	}
	var se *StatusError

	// retry-after-ms chico: el SDK reintenta (2 veces) casi sin esperar.
	fast := map[string]string{"retry-after-ms": "1"}

	err := run(&fakeAnthropic{status: 401, errBody: `{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}`})
	if !errors.As(err, &se) || se.Status != 401 || !strings.Contains(err.Error(), "clave de API") {
		t.Errorf("401: %v", err)
	}

	err = run(&fakeAnthropic{status: 429, errBody: `{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}`, errHdr: map[string]string{"retry-after-ms": "1", "retry-after": "7"}})
	if !errors.As(err, &se) || se.Status != 429 || !strings.Contains(err.Error(), "rate limit") || !strings.Contains(err.Error(), "7 s") {
		t.Errorf("429: %v", err)
	}

	err = run(&fakeAnthropic{status: 529, errBody: `{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`, errHdr: fast})
	if !errors.As(err, &se) || se.Status != 529 || !strings.Contains(err.Error(), "sobrecargada") {
		t.Errorf("529: %v", err)
	}

	err = run(&fakeAnthropic{status: 404, errBody: `{"type":"error","error":{"type":"not_found_error","message":"model: claude-nope"}}`})
	if !errors.As(err, &se) || se.Status != 404 || !strings.Contains(err.Error(), "claude-nope") {
		t.Errorf("404: %v", err)
	}

	// Un error en pleno stream (HTTP 200 + evento error).
	err = run(&fakeAnthropic{streams: []string{msgStart(defaultUsage) + sse("error", `{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`)}})
	if !errors.As(err, &se) || se.Status != 529 {
		t.Errorf("error en el stream: %v", err)
	}

	// Stream que se corta sin llegar a nada: un corte, reintentable.
	err = run(&fakeAnthropic{streams: []string{""}})
	if !IsRetryable(err) {
		t.Errorf("stream vacío debería ser un corte reintentable: %v", err)
	}
}

func TestAnthropicHealthCheckErrorIsStatusError(t *testing.T) {
	f := &fakeAnthropic{status: 401, errBody: `{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}`}
	c := newAnthropicTest(t, f, Options{Token: "mala"})
	_, err := c.Models(context.Background())
	var se *StatusError
	if !errors.As(err, &se) || se.Status != 401 {
		t.Errorf("Models con clave mala: %v", err)
	}
}

func TestAnthropicCancel(t *testing.T) {
	block := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/v1/models/") {
			w.WriteHeader(404)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, msgStart(defaultUsage))
		w.(http.Flusher).Flush()
		<-block
	}))
	defer srv.Close()
	defer close(block)
	c, _ := New(KindAnthropic, srv.URL, Options{})
	ctx, cancel := context.WithCancel(context.Background())
	go func() { cancel() }()
	_, err := c.Chat(ctx, ChatRequest{Messages: []Message{{Role: RoleUser, Content: "x"}}}, nil)
	if !errors.Is(err, context.Canceled) {
		t.Errorf("err = %v", err)
	}
}

func TestBuildAnthropicMessages(t *testing.T) {
	dir := t.TempDir()
	png := filepath.Join(dir, "a.png")
	// Cabecera PNG mínima: alcanza para que http.DetectContentType diga image/png.
	if err := os.WriteFile(png, []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"), 0o600); err != nil {
		t.Fatal(err)
	}
	system, msgs, err := buildAnthropicMessages([]Message{
		{Role: RoleSystem, Content: "uno"},
		{Role: RoleSystem, Content: "dos"},
		{Role: RoleUser, Content: "mirá", Images: []string{png}},
		{Role: RoleAssistant, Content: "", ToolCalls: []ToolCall{{Name: "mcp.tool", Arguments: map[string]any{"a": 1}}}},
		{Role: RoleTool, ToolCallID: "toolu_0", Content: ""},
		{Role: RoleUser, Content: "seguí"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(system) != 1 || system[0].Text != "uno\n\ndos" {
		t.Errorf("system = %+v", system)
	}
	if len(msgs) != 3 {
		t.Fatalf("mensajes = %d", len(msgs))
	}
	if msgs[0].Content[0].OfImage == nil || msgs[0].Content[1].OfText == nil {
		t.Errorf("la imagen va antes del texto: %+v", msgs[0].Content)
	}
	tu := msgs[1].Content[0].OfToolUse
	if tu == nil || tu.ID != "toolu_0" || tu.Name != "mcp_tool" {
		t.Errorf("tool_use sintético y nombre válido: %+v", msgs[1].Content[0])
	}
	// El tool_result va antes del texto del usuario aunque se fundan.
	last := msgs[2].Content
	if len(last) != 2 || last[0].OfToolResult == nil || last[1].OfText == nil {
		t.Errorf("tool_result primero: %+v", last)
	}
	if _, _, err := buildAnthropicMessages([]Message{{Role: RoleUser, Images: []string{filepath.Join(dir, "no-existe.png")}}}); err == nil {
		t.Error("una imagen ilegible debe fallar")
	}
}

func TestAnthropicToolNameRoundTrip(t *testing.T) {
	f := &fakeAnthropic{caps: modernCaps, streams: []string{msgStart(defaultUsage) + toolBlock(0, "toolu_1", "notes_create", `{}`) + msgEnd("tool_use", "", 3)}}
	c := newAnthropicTest(t, f, Options{})
	res, err := c.Chat(context.Background(), ChatRequest{
		Messages: []Message{{Role: RoleUser, Content: "x"}},
		Tools:    []ToolDef{{Name: "notes.create", Parameters: map[string]any{"type": "object"}}},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	tools, _ := f.body(0)["tools"].([]any)
	if sub(tools[0].(map[string]any), "name") != "notes_create" {
		t.Errorf("el nombre se manda saneado: %v", tools)
	}
	if res.Message.ToolCalls[0].Name != "notes.create" {
		t.Errorf("y vuelve el original: %+v", res.Message.ToolCalls)
	}
}

func TestAnthropicIsAdminListOnly(t *testing.T) {
	f := &fakeAnthropic{}
	c := newAnthropicTest(t, f, Options{})
	adm, ok := AsAdmin(c)
	if !ok {
		t.Fatal("Anthropic debe implementar Admin")
	}
	list, err := adm.ListModels(context.Background())
	if err != nil || len(list) != 2 || list[0].Name != "claude-opus-5-5" || list[0].ModifiedAt == "" {
		t.Errorf("ListModels = %+v, %v", list, err)
	}
	for name, err := range map[string]error{
		"pull":   adm.PullModel(context.Background(), "x", nil),
		"delete": adm.DeleteModel(context.Background(), "x"),
		"unload": adm.UnloadModel(context.Background(), "x"),
	} {
		if !IsUnsupported(err) {
			t.Errorf("%s debería ser no soportado: %v", name, err)
		}
	}
	if _, err := adm.RunningModels(context.Background()); !IsUnsupported(err) {
		t.Errorf("running: %v", err)
	}
	if _, err := adm.ShowModel(context.Background(), "x"); !IsUnsupported(err) {
		t.Errorf("show: %v", err)
	}
}
