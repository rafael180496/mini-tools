package llm

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"mini-tools/backend/i18n"
)

// Administración de modelos de un servidor: listar, ver detalle, descargar
// (pull), borrar y descargar de memoria.
//
// Solo Ollama expone esto en su API (/api/tags, /api/ps, /api/show,
// /api/pull, /api/delete). El protocolo de OpenAI sabe listar modelos y nada
// más: LM Studio, vLLM y llama.cpp cargan los suyos con su propia herramienta.
// Por eso los dos clientes implementan Admin, pero el de OpenAI contesta
// *UnsupportedError a todo salvo la lista, y la interfaz esconde esas acciones
// en vez de dejar que el usuario las pruebe y falle.
//
// Todo pasa por el `requester` de siempre: mismo token, mismas cabeceras
// propias y mismo transporte (con o sin verificación de certificado) que el
// chat, así que un servidor remoto detrás de un proxy con `X-Api-Key` se
// administra igual que se conversa con él.

// ManagedModel es un modelo instalado en el servidor.
type ManagedModel struct {
	Name string `json:"name"`
	// Size son los bytes en disco (0 si el servidor no lo informa).
	Size int64 `json:"size"`
	// ModifiedAt es hora de pared en RFC 3339 tal como la manda el servidor;
	// vacío si no la informa.
	ModifiedAt        string `json:"modifiedAt"`
	Digest            string `json:"digest"`
	Family            string `json:"family"`
	ParameterSize     string `json:"parameterSize"`
	QuantizationLevel string `json:"quantizationLevel"`
	Format            string `json:"format"`
}

// RunningModel es un modelo cargado en memoria ahora mismo (GET /api/ps).
type RunningModel struct {
	Name string `json:"name"`
	// Size es lo que ocupa cargado; SizeVRAM, la parte que está en la GPU. Si
	// SizeVRAM es menor que Size, el modelo está parcial o totalmente en RAM.
	Size     int64 `json:"size"`
	SizeVRAM int64 `json:"sizeVram"`
	// ExpiresAt es cuándo lo descarga el servidor por inactividad (RFC 3339).
	ExpiresAt     string `json:"expiresAt"`
	ContextLength int64  `json:"contextLength"`
}

// ModelDetails es lo que contesta POST /api/show, recortado a lo que se lee.
type ModelDetails struct {
	Name              string `json:"name"`
	Family            string `json:"family"`
	ParameterSize     string `json:"parameterSize"`
	QuantizationLevel string `json:"quantizationLevel"`
	Format            string `json:"format"`
	// Parameters es el bloque de parámetros del Modelfile (temperature, stop…).
	Parameters string `json:"parameters"`
	// Template es la plantilla del prompt, recortada a detailTemplateMax.
	Template string `json:"template"`
	// License es el comienzo de la licencia, recortado a detailLicenseMax.
	License string `json:"license"`
	// ContextLength es la ventana de contexto con la que se entrenó (0 si el
	// servidor no la informa).
	ContextLength int64    `json:"contextLength"`
	Capabilities  []string `json:"capabilities"`
}

// Tope de lo que se trae de /api/show: la licencia completa de un modelo
// puede pasar de 10 KB y la interfaz solo necesita reconocerla.
const (
	detailTemplateMax = 4000
	detailLicenseMax  = 1200
	detailParamsMax   = 4000
)

// PullProgress es una línea del stream de /api/pull. Cada capa del modelo
// (cada digest) trae su propio total y completed; Status sin digest
// («pulling manifest», «verifying sha256 digest», «success») no trae bytes.
type PullProgress struct {
	Status    string `json:"status"`
	Digest    string `json:"digest"`
	Total     int64  `json:"total"`
	Completed int64  `json:"completed"`
}

// Admin es lo que ofrece un servidor para administrar sus modelos.
type Admin interface {
	// ListModels devuelve los modelos instalados.
	ListModels(ctx context.Context) ([]ManagedModel, error)
	// RunningModels devuelve los cargados en memoria.
	RunningModels(ctx context.Context) ([]RunningModel, error)
	// ShowModel devuelve el detalle de un modelo.
	ShowModel(ctx context.Context, model string) (ModelDetails, error)
	// PullModel descarga un modelo y llama a onProgress por cada línea del
	// stream (puede ser nil). Termina cuando el servidor dice «success», falla
	// o ctx se cancela.
	PullModel(ctx context.Context, model string, onProgress func(PullProgress)) error
	// DeleteModel borra un modelo del disco del servidor.
	DeleteModel(ctx context.Context, model string) error
	// UnloadModel lo descarga de la memoria sin borrarlo.
	UnloadModel(ctx context.Context, model string) error
}

var (
	_ Admin = (*ollamaClient)(nil)
	_ Admin = (*openaiClient)(nil)
)

// AsAdmin devuelve la administración de un cliente. Los dos clientes de New la
// implementan; cualquier otro envoltorio que no, no es administrable.
func AsAdmin(c Client) (Admin, bool) {
	a, ok := c.(Admin)
	return a, ok
}

// UnsupportedError es una acción que este tipo de servidor no ofrece.
type UnsupportedError struct {
	Kind   string
	Action string
}

func (e *UnsupportedError) Error() string {
	return i18n.T(i18n.Msg{
		ES: "este tipo de servidor (%s) no permite %s desde acá: administrá los modelos con la herramienta del propio servidor",
		EN: "this server type (%s) does not allow %s from here: manage models with the server's own tool",
	}, e.Kind, e.Action)
}

// IsUnsupported dice si err es una acción no soportada por el tipo de servidor.
func IsUnsupported(err error) bool {
	var ue *UnsupportedError
	return errors.As(err, &ue)
}

// --- Nombre de modelo --------------------------------------------------------

// Un nombre de modelo de Ollama es `[host[:puerto]/][espacio/]nombre[:tag]`:
// `llama3.2`, `qwen2.5-coder:7b`, `hf.co/usuario/repo:Q4_K_M`,
// `registro.interno:5000/equipo/modelo:1.0`. La regla acepta ese alfabeto y
// rechaza lo demás —espacios, controles, comillas, `\`— porque el nombre
// viaja dentro de un JSON que arma esta capa, pero también se muestra en la
// interfaz y se compara con la lista del servidor.
var modelNameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._\-/:@]*$`)

const modelNameMax = 255

// ValidateModelName valida y normaliza (recorta los bordes) un nombre de
// modelo. Un espacio o un carácter de control en el medio es un error: casi
// siempre es un pegado con basura, y el servidor contestaría un 400 menos
// claro.
func ValidateModelName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	switch {
	case name == "":
		return "", i18n.Errorf(i18n.Msg{ES: "falta el nombre del modelo", EN: "the model name is missing"})
	case len(name) > modelNameMax:
		return "", i18n.Errorf(i18n.Msg{ES: "el nombre del modelo es demasiado largo (máximo %d caracteres)", EN: "the model name is too long (maximum %d characters)"}, modelNameMax)
	case !modelNameRe.MatchString(name) || strings.Contains(name, "//") || strings.Contains(name, ".."):
		return "", i18n.Errorf(i18n.Msg{
			ES: "el nombre del modelo no es válido: usá el formato nombre o nombre:etiqueta (por ejemplo qwen2.5-coder:7b), sin espacios",
			EN: "the model name is not valid: use the name or name:tag format (for example qwen2.5-coder:7b), with no spaces",
		})
	}
	return name, nil
}

// --- Ollama -------------------------------------------------------------------

// ollamaDetails es el bloque `details` que repiten /api/tags y /api/show.
type ollamaDetails struct {
	Format            string `json:"format"`
	Family            string `json:"family"`
	ParameterSize     string `json:"parameter_size"`
	QuantizationLevel string `json:"quantization_level"`
}

func (c *ollamaClient) ListModels(ctx context.Context) ([]ManagedModel, error) {
	ctx, cancel := context.WithTimeout(ctx, controlTimeout)
	defer cancel()
	var out struct {
		Models []struct {
			Name       string        `json:"name"`
			Model      string        `json:"model"`
			ModifiedAt string        `json:"modified_at"`
			Size       int64         `json:"size"`
			Digest     string        `json:"digest"`
			Details    ollamaDetails `json:"details"`
		} `json:"models"`
	}
	if err := c.getJSON(ctx, "/api/tags", &out); err != nil {
		return nil, err
	}
	list := make([]ManagedModel, 0, len(out.Models))
	for _, m := range out.Models {
		name := firstNonEmpty(m.Name, m.Model)
		if name == "" {
			continue
		}
		list = append(list, ManagedModel{
			Name: name, Size: m.Size, ModifiedAt: m.ModifiedAt, Digest: m.Digest,
			Family: m.Details.Family, ParameterSize: m.Details.ParameterSize,
			QuantizationLevel: m.Details.QuantizationLevel, Format: m.Details.Format,
		})
	}
	sort.SliceStable(list, func(i, j int) bool { return strings.ToLower(list[i].Name) < strings.ToLower(list[j].Name) })
	return list, nil
}

func (c *ollamaClient) RunningModels(ctx context.Context) ([]RunningModel, error) {
	ctx, cancel := context.WithTimeout(ctx, controlTimeout)
	defer cancel()
	var out struct {
		Models []struct {
			Name          string `json:"name"`
			Model         string `json:"model"`
			Size          int64  `json:"size"`
			SizeVRAM      int64  `json:"size_vram"`
			ExpiresAt     string `json:"expires_at"`
			ContextLength int64  `json:"context_length"`
		} `json:"models"`
	}
	if err := c.getJSON(ctx, "/api/ps", &out); err != nil {
		return nil, err
	}
	list := make([]RunningModel, 0, len(out.Models))
	for _, m := range out.Models {
		name := firstNonEmpty(m.Name, m.Model)
		if name == "" {
			continue
		}
		list = append(list, RunningModel{Name: name, Size: m.Size, SizeVRAM: m.SizeVRAM, ExpiresAt: m.ExpiresAt, ContextLength: m.ContextLength})
	}
	return list, nil
}

func (c *ollamaClient) ShowModel(ctx context.Context, model string) (ModelDetails, error) {
	ctx, cancel := context.WithTimeout(ctx, controlTimeout)
	defer cancel()
	var out struct {
		License      string                     `json:"license"`
		Parameters   string                     `json:"parameters"`
		Template     string                     `json:"template"`
		Details      ollamaDetails              `json:"details"`
		ModelInfo    map[string]json.RawMessage `json:"model_info"`
		Capabilities []string                   `json:"capabilities"`
	}
	if err := c.postJSON(ctx, "/api/show", nameBody(model, nil), &out); err != nil {
		return ModelDetails{}, err
	}
	d := ModelDetails{
		Name: model, Family: out.Details.Family, ParameterSize: out.Details.ParameterSize,
		QuantizationLevel: out.Details.QuantizationLevel, Format: out.Details.Format,
		Parameters:    cutRunes(strings.TrimSpace(out.Parameters), detailParamsMax),
		Template:      cutRunes(strings.TrimSpace(out.Template), detailTemplateMax),
		License:       cutRunes(strings.TrimSpace(out.License), detailLicenseMax),
		ContextLength: contextLengthOf(out.ModelInfo),
		Capabilities:  out.Capabilities,
	}
	if d.Capabilities == nil {
		d.Capabilities = []string{}
	}
	return d, nil
}

// contextLengthOf busca `<arquitectura>.context_length` en model_info: la
// clave lleva el nombre de la arquitectura (`llama.context_length`,
// `qwen2.context_length`…), así que se busca por sufijo.
func contextLengthOf(info map[string]json.RawMessage) int64 {
	keys := make([]string, 0, len(info))
	for k := range info {
		if strings.HasSuffix(k, ".context_length") {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	for _, k := range keys {
		var n float64
		if json.Unmarshal(info[k], &n) == nil && n > 0 {
			return int64(n)
		}
	}
	return 0
}

// cutRunes recorta a n caracteres (no bytes: un recorte a mitad de un
// carácter multibyte rompería el texto) y marca el corte con «…».
func cutRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n]) + "…"
}

func (c *ollamaClient) PullModel(ctx context.Context, model string, onProgress func(PullProgress)) error {
	raw, err := json.Marshal(nameBody(model, map[string]any{"stream": true}))
	if err != nil {
		return err
	}
	hr, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+"/api/pull", bytes.NewReader(raw))
	if err != nil {
		return err
	}
	hr.Header.Set("Content-Type", "application/json")
	resp, err := c.do(hr)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	var line struct {
		PullProgress
		Error string `json:"error"`
	}
	finished := false
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 0, 64*1024), maxLine)
	for sc.Scan() {
		b := bytes.TrimSpace(sc.Bytes())
		if len(b) == 0 {
			continue
		}
		line.PullProgress, line.Error = PullProgress{}, ""
		if json.Unmarshal(b, &line) != nil {
			continue
		}
		if line.Error != "" {
			return i18n.Errorf(i18n.Msg{ES: "el servidor %s no pudo descargar el modelo: %s", EN: "the server %s could not pull the model: %s"}, c.base, trimSnippet(line.Error, nil))
		}
		if onProgress != nil {
			onProgress(line.PullProgress)
		}
		if line.Status == "success" {
			finished = true
		}
	}
	if err := sc.Err(); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return interruptedError(c.base, err)
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if !finished {
		return endedError(c.base)
	}
	return nil
}

func (c *ollamaClient) DeleteModel(ctx context.Context, model string) error {
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	raw, err := json.Marshal(nameBody(model, nil))
	if err != nil {
		return err
	}
	hr, err := http.NewRequestWithContext(ctx, http.MethodDelete, c.base+"/api/delete", bytes.NewReader(raw))
	if err != nil {
		return err
	}
	hr.Header.Set("Content-Type", "application/json")
	resp, err := c.do(hr)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
	return nil
}

// UnloadModel pide a Ollama que suelte el modelo de la memoria: un
// /api/generate sin prompt y con keep_alive 0 es la forma documentada.
func (c *ollamaClient) UnloadModel(ctx context.Context, model string) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	return c.postJSON(ctx, "/api/generate", map[string]any{"model": model, "keep_alive": 0}, nil)
}

// nameBody arma el cuerpo con el modelo bajo `model` y bajo `name`: los Ollama
// viejos (anteriores a 0.5) solo entienden `name`, los nuevos `model`, y los
// dos ignoran el campo que no conocen.
func nameBody(model string, extra map[string]any) map[string]any {
	body := map[string]any{"model": model, "name": model}
	for k, v := range extra {
		body[k] = v
	}
	return body
}

// postJSON manda un POST con cuerpo JSON y decodifica la respuesta en into
// (nil = descartarla).
func (c *ollamaClient) postJSON(ctx context.Context, path string, body any, into any) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+path, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if into == nil {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
		return nil
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(into); err != nil {
		return i18n.Errorf(i18n.Msg{ES: "la respuesta de %s no es la de un servidor Ollama: %w", EN: "the response from %s is not from an Ollama server: %w"}, c.base, err)
	}
	return nil
}

// --- Compatibles con OpenAI -------------------------------------------------

// ListModels de OpenAI: /models trae `id` y, a veces, `created` (unix). No hay
// tamaño, familia ni cuantización: esos datos no son parte de la API.
func (c *openaiClient) ListModels(ctx context.Context) ([]ManagedModel, error) {
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
			ID      string `json:"id"`
			Created int64  `json:"created"`
		} `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&out); err != nil {
		return nil, i18n.Errorf(i18n.Msg{ES: "la respuesta de %s no es la de un servidor compatible con OpenAI: %w", EN: "the response from %s is not from an OpenAI-compatible server: %w"}, c.base, err)
	}
	list := make([]ManagedModel, 0, len(out.Data))
	for _, m := range out.Data {
		if m.ID == "" {
			continue
		}
		mm := ManagedModel{Name: m.ID}
		if m.Created > 0 {
			mm.ModifiedAt = time.Unix(m.Created, 0).UTC().Format(time.RFC3339)
		}
		list = append(list, mm)
	}
	sort.SliceStable(list, func(i, j int) bool { return strings.ToLower(list[i].Name) < strings.ToLower(list[j].Name) })
	return list, nil
}

func (c *openaiClient) unsupported(action i18n.Msg) error {
	return &UnsupportedError{Kind: "OpenAI", Action: i18n.T(action)}
}

func (c *openaiClient) RunningModels(ctx context.Context) ([]RunningModel, error) {
	return nil, c.unsupported(i18n.Msg{ES: "ver los modelos cargados", EN: "listing the loaded models"})
}

func (c *openaiClient) ShowModel(ctx context.Context, model string) (ModelDetails, error) {
	return ModelDetails{}, c.unsupported(i18n.Msg{ES: "ver el detalle de un modelo", EN: "showing a model's details"})
}

func (c *openaiClient) PullModel(ctx context.Context, model string, onProgress func(PullProgress)) error {
	return c.unsupported(i18n.Msg{ES: "descargar modelos", EN: "pulling models"})
}

func (c *openaiClient) DeleteModel(ctx context.Context, model string) error {
	return c.unsupported(i18n.Msg{ES: "borrar modelos", EN: "deleting models"})
}

func (c *openaiClient) UnloadModel(ctx context.Context, model string) error {
	return c.unsupported(i18n.Msg{ES: "descargar modelos de la memoria", EN: "unloading models"})
}

// --- Progreso agregado --------------------------------------------------------

// PullTracker junta el progreso de las capas de un pull en un solo avance. Un
// modelo se baja en varias capas (el gran blob de pesos y unas pocas chicas),
// cada una con su propio total y completed; una barra única necesita la suma.
//
// El porcentaje no retrocede: las capas chicas se anuncian después de que la
// grande ya avanzó, y sumar su total hace caer la fracción un instante. Una
// barra que da marcha atrás parece un reintento.
type PullTracker struct {
	layers map[string]PullProgress
	order  []string
	peak   float64
}

// Update incorpora una línea del stream y devuelve el avance agregado.
func (t *PullTracker) Update(p PullProgress) (completed, total int64, percent float64) {
	if p.Digest != "" && p.Total > 0 {
		if t.layers == nil {
			t.layers = map[string]PullProgress{}
		}
		if _, ok := t.layers[p.Digest]; !ok {
			t.order = append(t.order, p.Digest)
		}
		t.layers[p.Digest] = p
	}
	for _, d := range t.order {
		l := t.layers[d]
		total += l.Total
		completed += min(l.Completed, l.Total)
	}
	if total > 0 {
		percent = float64(completed) * 100 / float64(total)
	}
	if percent < t.peak {
		percent = t.peak
	}
	t.peak = percent
	return completed, total, percent
}
