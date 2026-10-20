package llm

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"mini-tools/backend/i18n"
)

// openaiClient habla la API de OpenAI (/v1/chat/completions) con el stream
// SSE: líneas `data: {json}` y un `data: [DONE]` final. La URL base se da
// incluyendo el /v1 (http://localhost:1234/v1), como lo muestran LM Studio,
// vLLM y compañía.
type openaiClient struct {
	requester
}

// OpenAI no tiene un endpoint de versión: devolver "" es honesto, inventar
// una cadena no lo sería.
func (c *openaiClient) Version(ctx context.Context) (string, error) { return "", nil }

func (c *openaiClient) Models(ctx context.Context) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, controlTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+"/models", nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var out struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&out); err != nil {
		return nil, i18n.Errorf(i18n.Msg{ES: "la respuesta de %s no es la de un servidor compatible con OpenAI: %w", EN: "the response from %s is not from an OpenAI-compatible server: %w"}, c.base, err)
	}
	names := make([]string, 0, len(out.Data))
	for _, m := range out.Data {
		if m.ID != "" {
			names = append(names, openaiModelID(c.base, m.ID))
		}
	}
	return names, nil
}

// openaiModelID deja el id tal como lo acepta /chat/completions. Google Gemini,
// por su endpoint compatible con OpenAI, lista sus modelos como
// «models/gemini-2.5-pro», y su chat documenta el nombre sin el prefijo: se
// elige de la lista ya como lo espera el chat.
func openaiModelID(base, id string) string {
	if u, err := url.Parse(base); err == nil && strings.EqualFold(u.Hostname(), "generativelanguage.googleapis.com") {
		return strings.TrimPrefix(id, "models/")
	}
	return id
}

type openaiPart struct {
	Type     string          `json:"type"`
	Text     string          `json:"text,omitempty"`
	ImageURL *openaiImageURL `json:"image_url,omitempty"`
}

type openaiImageURL struct {
	URL string `json:"url"`
}

type openaiToolCall struct {
	Index    int    `json:"index"`
	ID       string `json:"id,omitempty"`
	Type     string `json:"type,omitempty"`
	Function struct {
		Name string `json:"name,omitempty"`
		// Arguments viaja como cadena JSON, no como objeto.
		Arguments string `json:"arguments"`
	} `json:"function"`
}

// openaiOutCall es una llamada en un mensaje que SE ENVÍA. Sin `index`: ese
// campo existe solo en los deltas del stream, y algunos servidores estrictos
// rechazan el request si aparece en un mensaje del historial.
type openaiOutCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

type openaiMessage struct {
	Role string `json:"role"`
	// Content es string, array de partes (con imágenes) o null (un assistant
	// que solo pidió herramientas).
	Content    any             `json:"content"`
	ToolCalls  []openaiOutCall `json:"tool_calls,omitempty"`
	ToolCallID string          `json:"tool_call_id,omitempty"`
	Name       string          `json:"name,omitempty"`
}

type openaiTool struct {
	Type     string `json:"type"`
	Function struct {
		Name        string         `json:"name"`
		Description string         `json:"description,omitempty"`
		Parameters  map[string]any `json:"parameters,omitempty"`
	} `json:"function"`
}

type openaiChatRequest struct {
	Model         string          `json:"model"`
	Messages      []openaiMessage `json:"messages"`
	Tools         []openaiTool    `json:"tools,omitempty"`
	Stream        bool            `json:"stream"`
	StreamOptions map[string]any  `json:"stream_options,omitempty"`
}

type openaiChunk struct {
	Model   string `json:"model"`
	Choices []struct {
		Delta struct {
			Content          string           `json:"content"`
			ReasoningContent string           `json:"reasoning_content"`
			Reasoning        string           `json:"reasoning"`
			ToolCalls        []openaiToolCall `json:"tool_calls"`
		} `json:"delta"`
	} `json:"choices"`
	Usage *struct {
		PromptTokens     int64 `json:"prompt_tokens"`
		CompletionTokens int64 `json:"completion_tokens"`
	} `json:"usage"`
	Error json.RawMessage `json:"error"`
}

func (c *openaiClient) Chat(ctx context.Context, req ChatRequest, onDelta func(Delta)) (ChatResult, error) {
	if strings.TrimSpace(req.Model) == "" {
		return ChatResult{}, i18n.Errorf(i18n.Msg{ES: "llm: falta el modelo", EN: "llm: the model is missing"})
	}
	body := openaiChatRequest{
		Model:  req.Model,
		Stream: true,
		// Sin esto el servidor no informa los tokens en el stream.
		StreamOptions: map[string]any{"include_usage": true},
	}
	for _, m := range req.Messages {
		om := openaiMessage{Role: m.Role}
		switch {
		case len(m.Images) > 0:
			parts := []openaiPart{}
			if m.Content != "" {
				parts = append(parts, openaiPart{Type: "text", Text: m.Content})
			}
			for _, img := range m.Images {
				b64, mime, err := readImage(img)
				if err != nil {
					return ChatResult{}, err
				}
				parts = append(parts, openaiPart{Type: "image_url", ImageURL: &openaiImageURL{URL: "data:" + mime + ";base64," + b64}})
			}
			om.Content = parts
		case m.Role == RoleAssistant && len(m.ToolCalls) > 0 && m.Content == "":
			om.Content = nil
		default:
			om.Content = m.Content
		}
		for i, tc := range m.ToolCalls {
			args, _ := json.Marshal(tc.Arguments)
			if tc.Arguments == nil {
				args = []byte("{}")
			}
			id := tc.ID
			if id == "" {
				id = "call_" + strconv.Itoa(i)
			}
			call := openaiOutCall{ID: id, Type: "function"}
			call.Function.Name = tc.Name
			call.Function.Arguments = string(args)
			om.ToolCalls = append(om.ToolCalls, call)
		}
		if m.Role == RoleTool {
			om.ToolCallID = m.ToolCallID
			om.Name = m.Name
		}
		body.Messages = append(body.Messages, om)
	}
	for _, t := range req.Tools {
		var ot openaiTool
		ot.Type = "function"
		ot.Function.Name = t.Name
		ot.Function.Description = t.Description
		ot.Function.Parameters = t.Parameters
		body.Tools = append(body.Tools, ot)
	}

	raw, err := json.Marshal(body)
	if err != nil {
		return ChatResult{}, err
	}
	hr, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+"/chat/completions", bytes.NewReader(raw))
	if err != nil {
		return ChatResult{}, err
	}
	hr.Header.Set("Content-Type", "application/json")
	hr.Header.Set("Accept", "text/event-stream")
	resp, err := c.do(hr)
	if err != nil {
		return ChatResult{}, err
	}
	defer resp.Body.Close()

	var text strings.Builder
	res := ChatResult{Model: req.Model}
	// Las llamadas a herramientas llegan en pedazos por índice: el nombre en
	// el primero y los argumentos repartidos en los siguientes.
	pending := map[int]*openaiToolCall{}
	done := false

	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 0, 64*1024), maxLine)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		data, ok := strings.CutPrefix(line, "data:")
		if !ok {
			// Comentarios (`: keep-alive`), `event:` y líneas vacías.
			continue
		}
		data = strings.TrimSpace(data)
		if data == "[DONE]" {
			done = true
			break
		}
		var ch openaiChunk
		if err := json.Unmarshal([]byte(data), &ch); err != nil {
			continue
		}
		if len(ch.Error) > 0 && string(ch.Error) != "null" {
			return ChatResult{}, i18n.Errorf(i18n.Msg{ES: "el servidor %s respondió con un error: %s", EN: "the server %s answered with an error: %s"}, c.base, trimSnippet(errorFromBody([]byte(`{"error":`+string(ch.Error)+`}`)), ch.Error))
		}
		if ch.Model != "" {
			res.Model = ch.Model
		}
		if ch.Usage != nil {
			res.Usage = Usage{Input: ch.Usage.PromptTokens, Output: ch.Usage.CompletionTokens}
		}
		for _, choice := range ch.Choices {
			d := choice.Delta
			if t := firstNonEmpty(d.ReasoningContent, d.Reasoning); t != "" && onDelta != nil {
				onDelta(Delta{Thinking: t})
			}
			if d.Content != "" {
				text.WriteString(d.Content)
				if onDelta != nil {
					onDelta(Delta{Text: d.Content})
				}
			}
			for _, tc := range d.ToolCalls {
				idx := tc.Index
				// Hay servidores que no mandan `index` (todos llegan como 0):
				// un id distinto al de la llamada en curso es una llamada
				// nueva, no la continuación de la anterior.
				if p := pending[idx]; p != nil && tc.ID != "" && p.ID != "" && tc.ID != p.ID {
					idx = len(pending)
					for pending[idx] != nil {
						idx++
					}
				}
				p := pending[idx]
				if p == nil {
					p = &openaiToolCall{Index: idx}
					pending[idx] = p
				}
				if tc.ID != "" {
					p.ID = tc.ID
				}
				if tc.Function.Name != "" {
					p.Function.Name = tc.Function.Name
				}
				p.Function.Arguments += tc.Function.Arguments
			}
		}
	}
	if err := sc.Err(); err != nil {
		if ctx.Err() != nil {
			return ChatResult{}, ctx.Err()
		}
		return ChatResult{}, interruptedError(c.base, err)
	}
	if ctx.Err() != nil {
		return ChatResult{}, ctx.Err()
	}
	// Algunos servidores cierran sin mandar [DONE]; si ya llegó contenido se
	// da por completa. Sin nada de nada, es un corte.
	if !done && text.Len() == 0 && len(pending) == 0 {
		return ChatResult{}, endedError(c.base)
	}

	idx := make([]int, 0, len(pending))
	for i := range pending {
		idx = append(idx, i)
	}
	sort.Ints(idx)
	var calls []ToolCall
	for _, i := range idx {
		p := pending[i]
		args := map[string]any{}
		if s := strings.TrimSpace(p.Function.Arguments); s != "" {
			if err := json.Unmarshal([]byte(s), &args); err != nil {
				// Argumentos mal formados: se conservan crudos para que quien
				// ejecuta pueda devolverle el error al modelo en vez de perder
				// la llamada.
				args = map[string]any{"_raw": s}
			}
		}
		id := p.ID
		if id == "" {
			id = "call_" + strconv.Itoa(i)
		}
		calls = append(calls, ToolCall{ID: id, Name: p.Function.Name, Arguments: args})
	}
	res.Message = Message{Role: RoleAssistant, Content: text.String(), ToolCalls: calls}
	return res, nil
}
