package llm

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	anthropic "github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"

	"mini-tools/backend/i18n"
)

// Cliente de la API de Anthropic (Messages API) sobre el SDK oficial.
//
// # Qué se manda y por qué (verificado contra la guía oficial de la API)
//
//   - **Modelo**: el del turno; sin elegir, anthropicDefaultModel
//     (claude-opus-5-5). El runner puede pasar uno propio del proveedor
//     (`defaultModel`) antes de llegar acá.
//   - **Streaming siempre** y max_tokens 64000: con un max_tokens alto el SDK
//     exige streaming para no pasarse del timeout HTTP, y un tope bajo corta la
//     respuesta a mitad (el pensamiento también cuenta contra él).
//   - **Pensamiento adaptativo** con `display: "summarized"` cuando el modelo lo
//     admite (se consulta a la Models API, ver capsFor). Nunca `budget_tokens`
//     ni `disabled`: los modelos actuales los rechazan con 400. El display por
//     defecto es "omitted", que dejaría el panel de razonamiento vacío.
//   - **Effort explícito** (`output_config.effort`), igual al valor por defecto
//     documentado del modelo (medium en Opus 5.5 y Haiku 5.5, high en el
//     resto): así lo que se manda no depende de un default de la API que
//     cambia entre modelos.
//   - **Sin temperature/top_p/top_k, sin prefill y sin tool_choice forzado**:
//     los modelos actuales responden 400 a las tres cosas. tool_choice va en
//     `auto`.
//   - **Caché de prompt**: bloque de system con cache_control (las
//     instrucciones del proyecto son un prefijo estable) más el cache_control
//     del nivel superior, que va moviendo el punto de corte al último bloque
//     cacheable: en un bucle de herramientas cada vuelta relee la anterior.
//   - **Herramientas con eager_input_streaming**: la API deja de validar el
//     JSON de los argumentos, así que ESTE cliente lo valida (validToolInput)
//     antes de entregar la llamada.
//
// # Pensamiento preservado (preserved thinking)
//
// Los bloques `thinking` llevan una firma que ata el bloque a la conversación
// que lo produjo (system, tools y todos los mensajes anteriores). Reenviarlos
// tras editar ese prefijo es un 400 en cuentas nuevas. La regla de este
// cliente evita depender del prefijo: el contenido ORIGINAL del asistente
// (Message.Raw, con los bloques thinking y tool_use intactos) se reenvía solo
// dentro del turno abierto —desde el último mensaje del usuario en adelante,
// que es el bucle de herramientas—; los turnos anteriores se reenvían como
// texto y tool_use, SIN thinking. Así, recortar el historial, cambiar de modo
// (otro system, otras herramientas) o retomar un chat guardado no invalida
// nada: lo único que viaja con firma es lo que se acaba de producir con el
// mismo prefijo. El costo, a sabiendas: el razonamiento no cruza turnos.
//
// # Reintentos
//
// El SDK reintenta 408/409/429/5xx y fallos de conexión (2 veces, con
// retry-after). Por encima, chatRetry (agentchat) reintenta una vez los
// ConnError transitorios si todavía no llegó nada al usuario.
//
// # Lo que NO se usa
//
// `fallbacks` (reintento en otro modelo ante un refusal) solo existe en el
// namespace beta del SDK y exige una cabecera beta que un proxy puede
// rechazar; un refusal se informa como error claro (RefusalError).
const (
	anthropicDefaultModel = "claude-opus-5-5"
	// anthropicMaxTokens es el tope pedido; capsFor lo baja si el modelo
	// admite menos salida.
	anthropicMaxTokens = 64000
	// anthropicMaxPauseTurns acota las continuaciones tras stop_reason
	// pause_turn (solo ocurre con herramientas del servidor, que no se usan).
	anthropicMaxPauseTurns = 5
	// anthropicCapsTTL es cuánto se recuerdan las capacidades de un modelo.
	anthropicCapsTTL = time.Hour
)

// anthropicBlock es un bloque de contenido tal como se reenvía a la API. Message.Raw
// de este cliente es un []anthropicBlock.
type anthropicBlock = anthropic.ContentBlockParamUnion

type anthropicClient struct {
	base     string
	insecure bool
	api      anthropic.Client
}

func newAnthropicClient(r requester) *anthropicClient {
	opts := []option.RequestOption{
		// Sin esto el SDK lee ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL y los
		// perfiles de `ant auth login` del entorno: un proveedor guardado debe
		// usar SOLO lo que se le configuró.
		option.WithoutEnvironmentDefaults(),
		option.WithBaseURL(r.base),
		option.WithHTTPClient(r.http),
	}
	for k, v := range r.headers {
		opts = append(opts, option.WithHeader(k, v))
	}
	// El token va después de las cabeceras propias: si una se llamara X-Api-Key,
	// gana el token (misma regla que requester.do).
	if r.token != "" {
		opts = append(opts, option.WithAPIKey(r.token))
	}
	return &anthropicClient{base: r.base, insecure: r.insecure, api: anthropic.NewClient(opts...)}
}

// DefaultModel es el modelo cuando ni el turno ni el proveedor eligieron uno.
func (c *anthropicClient) DefaultModel() string { return anthropicDefaultModel }

// Anthropic no tiene un endpoint de versión: "" es honesto. El chequeo de
// salud usa Models().
func (c *anthropicClient) Version(ctx context.Context) (string, error) { return "", nil }

// Models lista los ids de los modelos (los más nuevos primero, como los
// devuelve la API).
func (c *anthropicClient) Models(ctx context.Context) ([]string, error) {
	infos, err := c.listModels(ctx)
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(infos))
	for _, m := range infos {
		if m.ID != "" {
			ids = append(ids, m.ID)
		}
	}
	return ids, nil
}

func (c *anthropicClient) listModels(ctx context.Context) ([]anthropic.ModelInfo, error) {
	ctx, cancel := context.WithTimeout(ctx, controlTimeout)
	defer cancel()
	pager := c.api.Models.ListAutoPaging(ctx, anthropic.ModelListParams{Limit: anthropic.Int(1000)})
	var out []anthropic.ModelInfo
	for pager.Next() {
		out = append(out, pager.Current())
	}
	if err := pager.Err(); err != nil {
		return nil, c.mapError(ctx, err)
	}
	return out, nil
}

// --- Capacidades por modelo ---------------------------------------------------

// anthropicCaps es lo que cambia el request según el modelo.
type anthropicCaps struct {
	adaptive  bool
	effort    map[anthropic.OutputConfigEffort]bool
	maxTokens int64
	// image y pdf: si el modelo acepta imágenes / PDF como entrada. live dice
	// que salieron de la Models API y no del plan B por familia (guessCaps),
	// que es lo que separa «el proveedor lo informó» de «se supone».
	image, pdf, live bool
}

type capsEntry struct {
	caps anthropicCaps
	at   time.Time
}

// anthropicCapsCache recuerda las capacidades por URL+modelo. El cliente se
// arma de nuevo en cada turno, así que sin esto cada mensaje pagaría un GET
// extra a /v1/models/{id}.
var anthropicCapsCache sync.Map

func allEfforts() map[anthropic.OutputConfigEffort]bool {
	return map[anthropic.OutputConfigEffort]bool{
		anthropic.OutputConfigEffortLow: true, anthropic.OutputConfigEffortMedium: true,
		anthropic.OutputConfigEffortHigh: true, anthropic.OutputConfigEffortXhigh: true, anthropic.OutputConfigEffortMax: true,
	}
}

// guessCaps es el plan B cuando la Models API no contesta (un proxy que no la
// expone): las familias actuales admiten pensamiento adaptativo y effort; de un
// modelo desconocido se asume lo mínimo, que funciona en todos.
func guessCaps(model string) anthropicCaps {
	for _, p := range []string{
		"claude-opus-5", "claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8", "claude-sonnet-5", "claude-sonnet-4-6",
		"claude-fable", "claude-mythos", "claude-haiku-5",
	} {
		if strings.HasPrefix(model, p) {
			return anthropicCaps{adaptive: true, effort: allEfforts(), maxTokens: anthropicMaxTokens, image: true, pdf: true}
		}
	}
	// Un modelo que no se reconoce se supone con visión y PDF: es lo que
	// admite toda la familia Claude, y si no, la API contesta con su error.
	return anthropicCaps{maxTokens: 8192, image: true, pdf: true}
}

// capsFor consulta GET /v1/models/{id} (capacidades en vivo, como recomienda la
// guía) y cae a guessCaps si no se puede. Un fallo no se recuerda: el próximo
// turno vuelve a intentarlo.
func (c *anthropicClient) capsFor(ctx context.Context, model string) anthropicCaps {
	key := c.base + "|" + model
	if v, ok := anthropicCapsCache.Load(key); ok {
		if e := v.(capsEntry); time.Since(e.at) < anthropicCapsTTL {
			return e.caps
		}
	}
	cctx, cancel := context.WithTimeout(ctx, controlTimeout)
	defer cancel()
	info, err := c.api.Models.Get(cctx, model, anthropic.ModelGetParams{})
	if err != nil || info == nil {
		return guessCaps(model)
	}
	caps := anthropicCaps{
		adaptive:  info.Capabilities.Thinking.Types.Adaptive.Supported,
		maxTokens: min(info.MaxTokens, anthropicMaxTokens),
		// Un campo ausente (un proxy que devuelve una versión recortada de la
		// ficha) no es «no soporta»: se supone, como en el plan B.
		image: !info.Capabilities.ImageInput.JSON.Supported.Valid() || info.Capabilities.ImageInput.Supported,
		pdf:   !info.Capabilities.PDFInput.JSON.Supported.Valid() || info.Capabilities.PDFInput.Supported,
		live:  info.Capabilities.ImageInput.JSON.Supported.Valid() && info.Capabilities.PDFInput.JSON.Supported.Valid(),
	}
	if info.MaxTokens <= 0 {
		caps.maxTokens = guessCaps(model).maxTokens
	}
	if e := info.Capabilities.Effort; e.Supported {
		caps.effort = map[anthropic.OutputConfigEffort]bool{
			anthropic.OutputConfigEffortLow: e.Low.Supported, anthropic.OutputConfigEffortMedium: e.Medium.Supported,
			anthropic.OutputConfigEffortHigh: e.High.Supported, anthropic.OutputConfigEffortXhigh: e.Xhigh.Supported,
			anthropic.OutputConfigEffortMax: e.Max.Supported,
		}
	}
	anthropicCapsCache.Store(key, capsEntry{caps: caps, at: time.Now()})
	return caps
}

// defaultEffort es el effort por defecto DOCUMENTADO de cada modelo: medium en
// Opus 5.5 y Haiku 5.5, high en los demás.
func defaultEffort(model string) anthropic.OutputConfigEffort {
	if strings.HasPrefix(model, "claude-opus-5-5") || strings.HasPrefix(model, "claude-haiku-5-5") {
		return anthropic.OutputConfigEffortMedium
	}
	return anthropic.OutputConfigEffortHigh
}

// --- Chat ---------------------------------------------------------------------

// Chat envía la conversación y transmite la respuesta.
func (c *anthropicClient) Chat(ctx context.Context, req ChatRequest, onDelta func(Delta)) (ChatResult, error) {
	model := strings.TrimSpace(req.Model)
	if model == "" {
		model = anthropicDefaultModel
	}
	system, msgs, err := buildAnthropicMessages(req.Messages)
	if err != nil {
		return ChatResult{}, err
	}
	if len(msgs) == 0 {
		return ChatResult{}, i18n.Errorf(i18n.Msg{ES: "llm: no hay ningún mensaje para enviar", EN: "llm: there is no message to send"})
	}

	caps := c.capsFor(ctx, model)
	params := anthropic.MessageNewParams{
		Model:     anthropic.Model(model),
		MaxTokens: caps.maxTokens,
		Messages:  msgs,
		// Caché automática del nivel superior: sigue al último bloque
		// cacheable, así cada vuelta del bucle de herramientas relee la anterior.
		CacheControl: anthropic.NewCacheControlEphemeralParam(),
	}
	if len(system) > 0 {
		params.System = system
	}
	if caps.adaptive {
		params.Thinking = anthropic.ThinkingConfigParamUnion{OfAdaptive: &anthropic.ThinkingConfigAdaptiveParam{Display: anthropic.ThinkingConfigAdaptiveDisplaySummarized}}
	}
	if eff := defaultEffort(model); caps.effort[eff] {
		params.OutputConfig = anthropic.OutputConfigParam{Effort: eff}
	}
	schemas := map[string]map[string]any{}
	originals := map[string]string{}
	if len(req.Tools) > 0 {
		params.Tools = buildAnthropicTools(req.Tools)
		params.ToolChoice = anthropic.ToolChoiceUnionParam{OfAuto: &anthropic.ToolChoiceAutoParam{}}
		for _, t := range req.Tools {
			n := anthropicToolName(t.Name)
			schemas[n] = t.Parameters
			originals[n] = t.Name
		}
	}

	var (
		text      strings.Builder
		calls     []ToolCall
		raw       []anthropicBlock
		usage     Usage
		respModel = model
	)
	for pause := 0; ; pause++ {
		msg, inputs, err := c.runStream(ctx, params, onDelta)
		if err != nil {
			return ChatResult{}, err
		}
		usage.Input += msg.Usage.InputTokens + msg.Usage.CacheReadInputTokens + msg.Usage.CacheCreationInputTokens
		usage.Output += msg.Usage.OutputTokens
		usage.CacheRead += msg.Usage.CacheReadInputTokens
		usage.CacheWrite += msg.Usage.CacheCreationInputTokens
		usage.Thinking += msg.Usage.OutputTokensDetails.ThinkingTokens
		if msg.Model != "" {
			respModel = string(msg.Model)
		}

		// El stop_reason se mira ANTES de tocar el contenido: un refusal o un
		// corte por tokens pueden dejar un tool_use a medias, que no se ejecuta.
		if msg.StopReason == anthropic.StopReasonRefusal {
			return ChatResult{}, &RefusalError{Category: string(msg.StopDetails.Category), Explanation: msg.StopDetails.Explanation}
		}
		truncated := msg.StopReason == anthropic.StopReasonMaxTokens || msg.StopReason == anthropic.StopReasonModelContextWindowExceeded
		hasTool := false
		for i, b := range msg.Content {
			switch b.Type {
			case "text":
				text.WriteString(b.Text)
				if strings.TrimSpace(b.Text) != "" {
					raw = append(raw, b.ToParam())
				}
			case "tool_use":
				hasTool = true
				in := inputs[int64(i)]
				if in == "" {
					in = string(b.Input)
				}
				name := b.Name
				if o, ok := originals[name]; ok {
					name = o
				}
				args, ok := validToolInput(schemas[b.Name], in)
				if !ok {
					// Argumentos inválidos o cortados: se conservan crudos (el
					// runner se los devuelve al modelo como error) y en el
					// historial reenviado el bloque lleva {} para que sea JSON.
					args = map[string]any{"_raw": in}
					in = "{}"
				}
				calls = append(calls, ToolCall{ID: b.ID, Name: name, Arguments: args})
				raw = append(raw, anthropic.NewToolUseBlock(b.ID, json.RawMessage(in), b.Name))
			default:
				// thinking, redacted_thinking y cualquier bloque que el SDK
				// modele: vuelven tal cual.
				raw = append(raw, b.ToParam())
			}
		}
		if truncated && hasTool {
			return ChatResult{}, &TruncatedError{ContextWindow: msg.StopReason == anthropic.StopReasonModelContextWindowExceeded}
		}
		if truncated {
			note := truncationNotice(msg.StopReason == anthropic.StopReasonModelContextWindowExceeded)
			text.WriteString(note)
			if onDelta != nil {
				onDelta(Delta{Text: note})
			}
		}
		if msg.StopReason == anthropic.StopReasonPauseTurn && pause < anthropicMaxPauseTurns {
			// El modelo pidió seguir (herramientas del servidor): se reenvía lo
			// que dijo y se continúa.
			params.Messages = append(params.Messages, msg.ToParam())
			continue
		}
		break
	}

	res := ChatResult{Model: respModel, Usage: usage}
	res.Message = Message{Role: RoleAssistant, Content: text.String(), ToolCalls: calls}
	if len(raw) > 0 {
		res.Message.Raw = raw
	}
	return res, nil
}

// runStream ejecuta UN request en streaming y devuelve el mensaje acumulado y
// los argumentos crudos de cada tool_use (por índice de bloque).
//
// El SDK arma los argumentos con un parser tolerante: uno inválido o cortado
// lo reemplaza por `{}` en silencio. Con eager_input_streaming eso es peligroso
// (se ejecutaría la herramienta con argumentos vacíos), así que acá se
// acumula el JSON crudo por separado y se valida aparte.
func (c *anthropicClient) runStream(ctx context.Context, params anthropic.MessageNewParams, onDelta func(Delta)) (anthropic.Message, map[int64]string, error) {
	stream := c.api.Messages.NewStreaming(ctx, params)
	defer stream.Close()
	var msg anthropic.Message
	partials := map[int64]*strings.Builder{}
	for stream.Next() {
		ev := stream.Current()
		if err := msg.Accumulate(ev); err != nil {
			return msg, nil, i18n.Errorf(i18n.Msg{ES: "la respuesta de %s no tiene el formato esperado: %w", EN: "the response from %s does not have the expected format: %w"}, c.base, err)
		}
		if ev.Type != "content_block_delta" {
			continue
		}
		switch d := ev.Delta; d.Type {
		case "text_delta":
			if d.Text != "" && onDelta != nil {
				onDelta(Delta{Text: d.Text})
			}
		case "thinking_delta":
			if d.Thinking != "" && onDelta != nil {
				onDelta(Delta{Thinking: d.Thinking})
			}
		case "input_json_delta":
			b := partials[ev.Index]
			if b == nil {
				b = &strings.Builder{}
				partials[ev.Index] = b
			}
			b.WriteString(d.PartialJSON)
		}
	}
	if err := stream.Err(); err != nil {
		return msg, nil, c.mapError(ctx, err)
	}
	if ctx.Err() != nil {
		return msg, nil, ctx.Err()
	}
	if msg.StopReason == "" && len(msg.Content) == 0 {
		// El stream se cerró sin llegar ni al message_delta: un corte.
		return msg, nil, endedError(c.base)
	}
	inputs := make(map[int64]string, len(partials))
	for i, b := range partials {
		inputs[i] = b.String()
	}
	return msg, inputs, nil
}

// --- Errores ------------------------------------------------------------------

// RefusalError es una respuesta que los filtros de seguridad de Anthropic
// rechazaron (stop_reason "refusal"): HTTP 200, sin contenido útil.
type RefusalError struct {
	// Category es stop_details.category (cyber, bio, reasoning_extraction,
	// frontier_llm, general_harms…; vacío si no la informó).
	Category    string
	Explanation string
}

func (e *RefusalError) Error() string {
	cat := e.Category
	if cat == "" {
		cat = "-"
	}
	msg := i18n.T(i18n.Msg{
		ES: "Anthropic rechazó este pedido por sus filtros de seguridad (categoría: %s). Reformulá el pedido o probá con otro modelo.",
		EN: "Anthropic declined this request with its safety filters (category: %s). Rephrase the request or try another model.",
	}, cat)
	if e.Explanation != "" {
		msg += " " + e.Explanation
	}
	return msg
}

// TruncatedError es una respuesta cortada antes de terminar una llamada a
// herramienta: sus argumentos están incompletos y no se pueden ejecutar.
type TruncatedError struct {
	// ContextWindow: el corte fue por la ventana de contexto y no por max_tokens.
	ContextWindow bool
}

func (e *TruncatedError) Error() string {
	if e.ContextWindow {
		return i18n.T(i18n.Msg{ES: "la conversación superó la ventana de contexto del modelo antes de terminar la llamada a la herramienta. Empezá un chat nuevo o resumí lo anterior", EN: "the conversation exceeded the model's context window before the tool call finished. Start a new chat or summarize the earlier part"})
	}
	return i18n.T(i18n.Msg{ES: "la respuesta se cortó por el límite de tokens antes de terminar la llamada a la herramienta; no se ejecutó. Pedile que lo haga en pasos más chicos", EN: "the response was cut off by the token limit before the tool call finished; it was not run. Ask it to do it in smaller steps"})
}

func truncationNotice(contextWindow bool) string {
	if contextWindow {
		return i18n.T(i18n.Msg{ES: "\n\n_⚠ La respuesta se cortó: la conversación llegó al límite de la ventana de contexto._", EN: "\n\n_⚠ The response was cut off: the conversation reached the context window limit._"})
	}
	return i18n.T(i18n.Msg{ES: "\n\n_⚠ La respuesta se cortó por el límite de tokens de salida._", EN: "\n\n_⚠ The response was cut off by the output token limit._"})
}

// mapError traduce un error del SDK a los tipos de este paquete: un fallo HTTP
// de la API es un *StatusError con un mensaje claro (así serverUnreachableError
// y el resto del código lo tratan igual que a los otros proveedores) y todo lo
// demás, un fallo de red clasificado (ConnError).
func (c *anthropicClient) mapError(ctx context.Context, err error) error {
	var ae *anthropic.Error
	if errors.As(err, &ae) {
		return c.statusError(ae)
	}
	return connError(ctx, c.base, c.insecure, err)
}

func (c *anthropicClient) statusError(ae *anthropic.Error) error {
	status := ae.StatusCode
	typ := string(ae.Type())
	if status < 400 {
		// Un evento `error` en pleno stream llega con el 200 de la respuesta: el
		// tipo es lo único que dice qué pasó.
		switch typ {
		case "overloaded_error":
			status = 529
		case "rate_limit_error":
			status = 429
		case "authentication_error":
			status = 401
		case "permission_error":
			status = 403
		case "not_found_error":
			status = 404
		case "billing_error":
			status = 402
		case "invalid_request_error":
			status = 400
		default:
			status = 500
		}
	}
	detail := trimSnippet(errorFromBody([]byte(ae.RawJSON())), []byte(ae.RawJSON()))
	var msg string
	switch {
	case status == 401:
		msg = i18n.T(i18n.Msg{ES: "la clave de API no es válida o falta. Revisá la clave del proveedor", EN: "the API key is invalid or missing. Check the provider's key"})
	case status == 402:
		msg = i18n.T(i18n.Msg{ES: "problema de facturación o de saldo en la cuenta de Anthropic: %s", EN: "billing or balance problem on the Anthropic account: %s"}, detail)
	case status == 403:
		msg = i18n.T(i18n.Msg{ES: "la clave no tiene permiso para esto (¿el modelo no está habilitado en tu organización?): %s", EN: "the key is not allowed to do this (is the model enabled for your organization?): %s"}, detail)
	case status == 404:
		msg = i18n.T(i18n.Msg{ES: "no se encontró el modelo o el recurso: %s", EN: "the model or resource was not found: %s"}, detail)
	case status == 413:
		msg = i18n.T(i18n.Msg{ES: "el pedido es demasiado grande para la API (¿imágenes o historial enormes?)", EN: "the request is too large for the API (huge images or history?)"})
	case status == 429:
		msg = i18n.T(i18n.Msg{ES: "se alcanzó el límite de uso de la API (rate limit)", EN: "the API usage limit (rate limit) was reached"})
		if ae.Response != nil {
			if s, err := strconv.Atoi(strings.TrimSpace(ae.Response.Header.Get("retry-after"))); err == nil && s > 0 {
				msg += i18n.T(i18n.Msg{ES: "; reintentá en %d s", EN: "; retry in %d s"}, s)
			}
		}
	case status == 529:
		msg = i18n.T(i18n.Msg{ES: "la API de Anthropic está sobrecargada; reintentá en unos minutos", EN: "Anthropic's API is overloaded; retry in a few minutes"})
	case status >= 500:
		msg = i18n.T(i18n.Msg{ES: "error del servicio de Anthropic: %s", EN: "Anthropic service error: %s"}, detail)
	default:
		msg = detail
	}
	return &StatusError{Base: c.base, Status: status, Msg: msg}
}

// --- Conversión de mensajes ---------------------------------------------------

// anthropicToolName deja el nombre dentro de lo que la API acepta
// (^[a-zA-Z0-9_-]{1,64}$).
func anthropicToolName(n string) string {
	b := make([]rune, 0, len(n))
	for _, r := range n {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_', r == '-':
			b = append(b, r)
		default:
			b = append(b, '_')
		}
	}
	if len(b) > 64 {
		b = b[:64]
	}
	if len(b) == 0 {
		return "_"
	}
	return string(b)
}

// buildAnthropicTools arma las definiciones. Van ORDENADAS por nombre: el orden
// de las herramientas es parte del prefijo de la caché y un orden que cambia
// entre turnos (el mapa de un servidor MCP, por ejemplo) la tiraría cada vez.
func buildAnthropicTools(defs []ToolDef) []anthropic.ToolUnionParam {
	sorted := append([]ToolDef(nil), defs...)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].Name < sorted[j].Name })
	out := make([]anthropic.ToolUnionParam, 0, len(sorted))
	for _, d := range sorted {
		tp := anthropic.ToolParam{
			Name:        anthropicToolName(d.Name),
			InputSchema: anthropicSchema(d.Parameters),
			// Con streaming y herramientas propias, la guía manda activarlo: los
			// argumentos grandes (el contenido de un archivo) llegan a medida que
			// se generan. A cambio la API no los valida: ver validToolInput.
			EagerInputStreaming: anthropic.Bool(true),
		}
		if d.Description != "" {
			tp.Description = anthropic.String(d.Description)
		}
		out = append(out, anthropic.ToolUnionParam{OfTool: &tp})
	}
	return out
}

func anthropicSchema(p map[string]any) anthropic.ToolInputSchemaParam {
	sp := anthropic.ToolInputSchemaParam{Properties: map[string]any{}}
	extra := map[string]any{}
	for k, v := range p {
		switch k {
		case "type":
		case "properties":
			if v != nil {
				sp.Properties = v
			}
		case "required":
			sp.Required = stringList(v)
		default:
			extra[k] = v
		}
	}
	if len(extra) > 0 {
		sp.ExtraFields = extra
	}
	return sp
}

func stringList(v any) []string {
	switch l := v.(type) {
	case []string:
		return l
	case []any:
		out := make([]string, 0, len(l))
		for _, x := range l {
			if s, ok := x.(string); ok {
				out = append(out, s)
			}
		}
		return out
	}
	return nil
}

// validToolInput decodifica los argumentos crudos de una llamada y los valida
// contra el esquema de la herramienta: tienen que ser un objeto JSON completo,
// con las propiedades requeridas y del tipo declarado. Es la validación que la
// API ya no hace con eager_input_streaming; una respuesta cortada por
// max_tokens suele dejar un objeto que parsea pero que le falta algo.
func validToolInput(schema map[string]any, raw string) (map[string]any, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		raw = "{}"
	}
	var args map[string]any
	if err := json.Unmarshal([]byte(raw), &args); err != nil || args == nil {
		return nil, false
	}
	for _, k := range stringList(schema["required"]) {
		if _, ok := args[k]; !ok {
			return nil, false
		}
	}
	props, _ := schema["properties"].(map[string]any)
	for k, v := range args {
		ps, _ := props[k].(map[string]any)
		t, _ := ps["type"].(string)
		if !jsonTypeMatches(t, v) {
			return nil, false
		}
	}
	return args, true
}

func jsonTypeMatches(t string, v any) bool {
	switch t {
	case "string":
		_, ok := v.(string)
		return ok
	case "boolean":
		_, ok := v.(bool)
		return ok
	case "number":
		_, ok := v.(float64)
		return ok
	case "integer":
		f, ok := v.(float64)
		return ok && f == float64(int64(f))
	case "array":
		_, ok := v.([]any)
		return ok
	case "object":
		_, ok := v.(map[string]any)
		return ok
	}
	return true // sin tipo declarado (o uno compuesto): no se opina
}

// buildAnthropicMessages traduce la conversación común a la de la API.
//
// Todos los system se juntan en el bloque `system` (con cache_control: es el
// prefijo estable). Los resultados de herramientas de una misma vuelta van en
// UN solo mensaje de usuario —con los tool_result primero, como exige la
// API— y los mensajes consecutivos del mismo rol se funden.
//
// El contenido original del asistente (Raw, con sus bloques thinking) solo se
// reenvía dentro del turno abierto: ver el comentario del paquete.
func buildAnthropicMessages(msgs []Message) ([]anthropic.TextBlockParam, []anthropic.MessageParam, error) {
	lastUser := -1
	for i, m := range msgs {
		if m.Role == RoleUser {
			lastUser = i
		}
	}
	var sys []string
	var out []anthropic.MessageParam
	add := func(role anthropic.MessageParamRole, blocks ...anthropic.ContentBlockParamUnion) {
		if len(blocks) == 0 {
			return
		}
		if n := len(out); n > 0 && out[n-1].Role == role {
			out[n-1].Content = append(out[n-1].Content, blocks...)
			if role == anthropic.MessageParamRoleUser {
				toolResultsFirst(out[n-1].Content)
			}
			return
		}
		out = append(out, anthropic.MessageParam{Role: role, Content: blocks})
	}
	for i, m := range msgs {
		switch m.Role {
		case RoleSystem:
			if strings.TrimSpace(m.Content) != "" {
				sys = append(sys, m.Content)
			}
		case RoleUser:
			var blocks []anthropic.ContentBlockParamUnion
			// Los PDF y las imágenes van antes del texto, como recomienda la
			// guía; el PDF primero.
			for _, doc := range m.PDFs {
				b64, err := readPDF(doc)
				if err != nil {
					return nil, nil, err
				}
				blocks = append(blocks, anthropic.NewDocumentBlock(anthropic.Base64PDFSourceParam{Data: b64}))
			}
			for _, img := range m.Images {
				b64, mime, err := readImage(img)
				if err != nil {
					return nil, nil, err
				}
				blocks = append(blocks, anthropic.NewImageBlockBase64(mime, b64))
			}
			if strings.TrimSpace(m.Content) != "" {
				blocks = append(blocks, anthropic.NewTextBlock(m.Content))
			}
			add(anthropic.MessageParamRoleUser, blocks...)
		case RoleAssistant:
			add(anthropic.MessageParamRoleAssistant, assistantBlocks(m, i > lastUser)...)
		case RoleTool:
			content := m.Content
			if strings.TrimSpace(content) == "" {
				content = "(empty)"
			}
			add(anthropic.MessageParamRoleUser, anthropic.NewToolResultBlock(m.ToolCallID, content, strings.HasPrefix(content, "error:")))
		}
	}
	var system []anthropic.TextBlockParam
	if len(sys) > 0 {
		system = []anthropic.TextBlockParam{{Text: strings.Join(sys, "\n\n"), CacheControl: anthropic.NewCacheControlEphemeralParam()}}
	}
	return system, out, nil
}

func assistantBlocks(m Message, openTurn bool) []anthropic.ContentBlockParamUnion {
	if openTurn {
		if raw, ok := m.Raw.([]anthropicBlock); ok && len(raw) > 0 {
			return raw
		}
	}
	var blocks []anthropic.ContentBlockParamUnion
	if strings.TrimSpace(m.Content) != "" {
		blocks = append(blocks, anthropic.NewTextBlock(m.Content))
	}
	for i, tc := range m.ToolCalls {
		id := tc.ID
		if id == "" {
			id = "toolu_" + strconv.Itoa(i)
		}
		var input any = tc.Arguments
		if _, bad := tc.Arguments["_raw"]; bad || tc.Arguments == nil {
			input = map[string]any{}
		}
		blocks = append(blocks, anthropic.NewToolUseBlock(id, input, anthropicToolName(tc.Name)))
	}
	return blocks
}

// toolResultsFirst deja los tool_result al frente del contenido de un mensaje
// de usuario (orden estable): la API rechaza un tool_result después de texto.
func toolResultsFirst(blocks []anthropic.ContentBlockParamUnion) {
	sort.SliceStable(blocks, func(i, j int) bool {
		return blocks[i].OfToolResult != nil && blocks[j].OfToolResult == nil
	})
}
