package agentchat

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"mini-tools/backend/llm"
)

// Cambio de proveedor en medio de un chat (App.SetAgentChatAgent): la memoria
// de la sesión sigue y lo opaco de un proveedor no viaja al otro.

// opaque hace de Message.Raw de un proveedor.
type opaque struct{ sig string }

func TestLLMProviderSwitchKeepsHistoryAndDropsForeignRaw(t *testing.T) {
	a := &scriptLLM{steps: []func(llm.ChatRequest, func(llm.Delta)) (llm.ChatResult, error){
		func(req llm.ChatRequest, on func(llm.Delta)) (llm.ChatResult, error) {
			return llm.ChatResult{Message: llm.Message{Role: llm.RoleAssistant, Content: "de A", Raw: opaque{"firma-a"}}, Model: req.Model}, nil
		},
		func(req llm.ChatRequest, on func(llm.Delta)) (llm.ChatResult, error) {
			return llm.ChatResult{Message: llm.Message{Role: llm.RoleAssistant, Content: "de A otra vez", Raw: opaque{"firma-a2"}}, Model: req.Model}, nil
		},
	}}
	b := &scriptLLM{steps: []func(llm.ChatRequest, func(llm.Delta)) (llm.ChatResult, error){say("de B", 1, 1)}}
	col := newCollector()
	m := NewManager(col.emit)

	runTurn(t, m, col, Turn{SessionID: "s", AgentID: "llm:a", Prompt: "uno", LLM: a})
	// Mismo proveedor: el Raw de lo anterior se conserva (no cambia nada hoy).
	runTurn(t, m, col, Turn{SessionID: "s", AgentID: "llm:a", Prompt: "dos", LLM: a})
	var kept int
	for _, msg := range a.requests[1].Messages {
		if msg.Raw != nil {
			kept++
		}
	}
	if kept != 1 {
		t.Fatalf("con el mismo proveedor el Raw tiene que seguir: %d", kept)
	}

	// Otro proveedor: ve toda la conversación, sin el Raw del anterior.
	runTurn(t, m, col, Turn{SessionID: "s", AgentID: "llm:b", Prompt: "tres", LLM: b})
	var texts []string
	for _, msg := range b.requests[0].Messages {
		if msg.Raw != nil {
			t.Fatalf("el Raw de otro proveedor llegó al nuevo: %+v", msg)
		}
		if msg.Role != llm.RoleSystem {
			texts = append(texts, msg.Role+":"+msg.Content)
		}
	}
	want := "user:uno|assistant:de A|user:dos|assistant:de A otra vez|user:tres"
	if strings.Join(texts, "|") != want {
		t.Fatalf("mensajes = %v", texts)
	}
	// La memoria guardada de ahora en más es la de B.
	m.mu.Lock()
	owner := m.llmHistoryAgent["s"]
	m.mu.Unlock()
	if owner != "llm:b" {
		t.Fatalf("dueño de la memoria = %q", owner)
	}
	// Y Reset la olvida junto con el dueño.
	m.Reset("s")
	m.mu.Lock()
	_, has := m.llmHistoryAgent["s"]
	m.mu.Unlock()
	if has {
		t.Fatal("Reset tiene que olvidar el dueño de la memoria")
	}
}

// Un chat que arranca contra un servidor compatible con OpenAI (con una
// herramienta de por medio) y sigue contra la API de Anthropic: el segundo
// proveedor recibe lo anterior como texto y tool_use/tool_result válidos, sin
// bloques de razonamiento.
func TestLLMChatStartsOnOpenAIContinuesOnAnthropic(t *testing.T) {
	var mu sync.Mutex
	var openaiBodies, anthropicBodies []map[string]any
	read := func(r *http.Request) map[string]any {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		return body
	}

	openaiRound := 0
	openaiSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		openaiBodies = append(openaiBodies, read(r))
		openaiRound++
		round := openaiRound
		mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		if round == 1 {
			fmt.Fprint(w, `data: {"model":"gpt-x","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc","function":{"name":"read_file","arguments":"{\"path\":\"a.txt\"}"}}]}}]}`+"\n\n")
		} else {
			fmt.Fprint(w, `data: {"model":"gpt-x","choices":[{"delta":{"content":"El archivo dice hola."}}]}`+"\n\n")
		}
		fmt.Fprint(w, `data: {"model":"gpt-x","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}`+"\n\ndata: [DONE]\n\n")
	}))
	t.Cleanup(openaiSrv.Close)

	anthropicSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/messages" {
			w.WriteHeader(404) // las capacidades del modelo: se usan las de reserva
			return
		}
		mu.Lock()
		anthropicBodies = append(anthropicBodies, read(r))
		mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		sse := func(typ, data string) { fmt.Fprint(w, "event: "+typ+"\ndata: "+data+"\n\n") }
		sse("message_start", `{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-x","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":9,"output_tokens":1}}}`)
		sse("content_block_start", `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`)
		sse("content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Sigo yo."}}`)
		sse("content_block_stop", `{"type":"content_block_stop","index":0}`)
		sse("message_delta", `{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null,"stop_details":null},"usage":{"output_tokens":4}}`)
		sse("message_stop", `{"type":"message_stop"}`)
	}))
	t.Cleanup(anthropicSrv.Close)

	oc, err := llm.New(llm.KindOpenAI, openaiSrv.URL, llm.Options{})
	if err != nil {
		t.Fatal(err)
	}
	ac, err := llm.New(llm.KindAnthropic, anthropicSrv.URL, llm.Options{Token: "k"})
	if err != nil {
		t.Fatal(err)
	}
	col := newCollector()
	m := NewManager(col.emit)
	run := func(agent string, c llm.Client, model, prompt string) []Event {
		return runTurn(t, m, col, Turn{
			SessionID: "chat", AgentID: agent, Prompt: prompt, LLM: c, Model: model, Tools: toolDefs,
			RunTool: func(context.Context, string, map[string]any) (string, error) { return "hola", nil },
		})
	}

	if evs := run("llm:o", oc, "gpt-x", "leé a.txt"); len(eventsOf(evs, KindError)) != 0 {
		t.Fatalf("OpenAI falló: %+v", evs)
	}
	evs := run("llm:c", ac, "claude-x", "¿y ahora?")
	if len(eventsOf(evs, KindError)) != 0 || len(eventsOf(evs, KindDone)) != 1 {
		t.Fatalf("Anthropic falló: %+v", evs)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(anthropicBodies) != 1 {
		t.Fatalf("pedidos a Anthropic = %d", len(anthropicBodies))
	}
	raw, _ := json.Marshal(anthropicBodies[0]["messages"])
	var msgs []struct {
		Role    string `json:"role"`
		Content []struct {
			Type      string `json:"type"`
			Text      string `json:"text"`
			ID        string `json:"id"`
			ToolUseID string `json:"tool_use_id"`
			Name      string `json:"name"`
		} `json:"content"`
	}
	if err := json.Unmarshal(raw, &msgs); err != nil {
		t.Fatal(err)
	}
	// user(leé) · assistant(tool_use) · user(tool_result) · assistant(texto) · user(¿y ahora?)
	var shape []string
	for _, msg := range msgs {
		for _, b := range msg.Content {
			if b.Type == "thinking" || b.Type == "redacted_thinking" {
				t.Fatalf("un bloque de razonamiento cruzó de proveedor: %s", raw)
			}
			switch b.Type {
			case "tool_use":
				if b.ID != "call_abc" || b.Name != "read_file" {
					t.Fatalf("tool_use = %+v", b)
				}
			case "tool_result":
				if b.ToolUseID != "call_abc" {
					t.Fatalf("tool_result = %+v", b)
				}
			}
			shape = append(shape, msg.Role+":"+b.Type)
		}
	}
	want := "user:text assistant:tool_use user:tool_result assistant:text user:text"
	if strings.Join(shape, " ") != want {
		t.Fatalf("forma = %v\n%s", shape, raw)
	}
	if !strings.Contains(string(raw), "El archivo dice hola.") || !strings.Contains(string(raw), "¿y ahora?") {
		t.Fatalf("falta contenido anterior: %s", raw)
	}
	if len(openaiBodies) != 2 {
		t.Fatalf("pedidos a OpenAI = %d", len(openaiBodies))
	}
}
