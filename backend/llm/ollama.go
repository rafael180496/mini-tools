package llm

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"mini-tools/backend/i18n"
)

// ollamaClient habla el protocolo nativo de Ollama (/api/*), que transmite
// NDJSON: una línea JSON por trozo, la última con `done: true`.
type ollamaClient struct {
	requester
	// numCtx es la ventana de contexto a pedir; 0 = la del servidor.
	numCtx int
}

func (c *ollamaClient) Version(ctx context.Context) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, controlTimeout)
	defer cancel()
	var out struct {
		Version string `json:"version"`
	}
	if err := c.getJSON(ctx, "/api/version", &out); err != nil {
		return "", err
	}
	return out.Version, nil
}

func (c *ollamaClient) Models(ctx context.Context) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, controlTimeout)
	defer cancel()
	var out struct {
		Models []struct {
			Name string `json:"name"`
		} `json:"models"`
	}
	if err := c.getJSON(ctx, "/api/tags", &out); err != nil {
		return nil, err
	}
	names := make([]string, 0, len(out.Models))
	for _, m := range out.Models {
		if m.Name != "" {
			names = append(names, m.Name)
		}
	}
	return names, nil
}

func (c *ollamaClient) getJSON(ctx context.Context, path string, into any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+path, nil)
	if err != nil {
		return err
	}
	resp, err := c.do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if err := json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(into); err != nil {
		return i18n.Errorf(i18n.Msg{ES: "la respuesta de %s no es la de un servidor Ollama: %w", EN: "the response from %s is not from an Ollama server: %w"}, c.base, err)
	}
	return nil
}

// --- /api/chat ------------------------------------------------------------

type ollamaMessage struct {
	Role      string           `json:"role"`
	Content   string           `json:"content"`
	Thinking  string           `json:"thinking,omitempty"`
	Images    []string         `json:"images,omitempty"`
	ToolCalls []ollamaToolCall `json:"tool_calls,omitempty"`
	ToolName  string           `json:"tool_name,omitempty"`
}

type ollamaToolCall struct {
	Function struct {
		Name      string         `json:"name"`
		Arguments map[string]any `json:"arguments"`
	} `json:"function"`
}

type ollamaTool struct {
	Type     string `json:"type"`
	Function struct {
		Name        string         `json:"name"`
		Description string         `json:"description,omitempty"`
		Parameters  map[string]any `json:"parameters,omitempty"`
	} `json:"function"`
}

type ollamaChatRequest struct {
	Model    string          `json:"model"`
	Messages []ollamaMessage `json:"messages"`
	Tools    []ollamaTool    `json:"tools,omitempty"`
	Stream   bool            `json:"stream"`
	Options  *ollamaOptions  `json:"options,omitempty"`
}

// ollamaOptions son los parámetros del modelo que acepta /api/chat. Hoy solo
// la ventana de contexto: Ollama arranca con 2k-4k tokens y recorta el prompt
// sin avisar, así que sin esto un system prompt largo se come el mensaje.
type ollamaOptions struct {
	NumCtx int `json:"num_ctx,omitempty"`
}

type ollamaChunk struct {
	Model           string        `json:"model"`
	Message         ollamaMessage `json:"message"`
	Done            bool          `json:"done"`
	PromptEvalCount int64         `json:"prompt_eval_count"`
	EvalCount       int64         `json:"eval_count"`
	Error           string        `json:"error"`
}

func (c *ollamaClient) Chat(ctx context.Context, req ChatRequest, onDelta func(Delta)) (ChatResult, error) {
	if strings.TrimSpace(req.Model) == "" {
		return ChatResult{}, i18n.Errorf(i18n.Msg{ES: "llm: falta el modelo", EN: "llm: the model is missing"})
	}
	body := ollamaChatRequest{Model: req.Model, Stream: true}
	if c.numCtx > 0 {
		body.Options = &ollamaOptions{NumCtx: c.numCtx}
	}
	for _, m := range req.Messages {
		om := ollamaMessage{Role: m.Role, Content: m.Content}
		for _, img := range m.Images {
			b64, _, err := readImage(img)
			if err != nil {
				return ChatResult{}, err
			}
			om.Images = append(om.Images, b64)
		}
		for _, tc := range m.ToolCalls {
			var call ollamaToolCall
			call.Function.Name = tc.Name
			call.Function.Arguments = tc.Arguments
			if call.Function.Arguments == nil {
				call.Function.Arguments = map[string]any{}
			}
			om.ToolCalls = append(om.ToolCalls, call)
		}
		if m.Role == RoleTool {
			om.ToolName = m.Name
		}
		body.Messages = append(body.Messages, om)
	}
	for _, t := range req.Tools {
		var ot ollamaTool
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
	hr, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+"/api/chat", bytes.NewReader(raw))
	if err != nil {
		return ChatResult{}, err
	}
	hr.Header.Set("Content-Type", "application/json")
	resp, err := c.do(hr)
	if err != nil {
		return ChatResult{}, err
	}
	defer resp.Body.Close()

	var text, thinking strings.Builder
	res := ChatResult{Model: req.Model}
	var calls []ToolCall
	finished := false

	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 0, 64*1024), maxLine)
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		var ch ollamaChunk
		if err := json.Unmarshal(line, &ch); err != nil {
			// Una línea que no es JSON no corta el turno: lo que importa es
			// lo que ya llegó.
			continue
		}
		if ch.Error != "" {
			return ChatResult{}, i18n.Errorf(i18n.Msg{ES: "el servidor %s respondió con un error: %s", EN: "the server %s answered with an error: %s"}, c.base, trimSnippet(ch.Error, nil))
		}
		if ch.Model != "" {
			res.Model = ch.Model
		}
		if t := ch.Message.Thinking; t != "" {
			thinking.WriteString(t)
			if onDelta != nil {
				onDelta(Delta{Thinking: t})
			}
		}
		if t := ch.Message.Content; t != "" {
			text.WriteString(t)
			if onDelta != nil {
				onDelta(Delta{Text: t})
			}
		}
		for _, tc := range ch.Message.ToolCalls {
			calls = append(calls, ToolCall{
				// Ollama no manda id: se inventa uno estable dentro del turno.
				ID:        fmt.Sprintf("call_%d", len(calls)),
				Name:      tc.Function.Name,
				Arguments: tc.Function.Arguments,
			})
		}
		if ch.Done {
			finished = true
			res.Usage = Usage{Input: ch.PromptEvalCount, Output: ch.EvalCount}
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
	if !finished {
		return ChatResult{}, endedError(c.base)
	}
	res.Message = Message{Role: RoleAssistant, Content: text.String(), ToolCalls: calls}
	return res, nil
}

// errorFromBody lee el `error` de un cuerpo de Ollama (texto) o de OpenAI
// (objeto con `message`).
func errorFromBody(body []byte) string {
	var e struct {
		Error json.RawMessage `json:"error"`
	}
	if json.Unmarshal(body, &e) != nil || len(e.Error) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(e.Error, &s) == nil {
		return s
	}
	var o struct {
		Message string `json:"message"`
	}
	if json.Unmarshal(e.Error, &o) == nil {
		return o.Message
	}
	return ""
}
