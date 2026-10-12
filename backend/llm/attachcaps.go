package llm

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"mini-tools/backend/i18n"
)

// Qué adjuntos acepta un modelo.
//
// La pregunta «¿este modelo ve imágenes?» tiene respuesta distinta en cada
// protocolo, y por eso es un método del cliente y no una tabla de nombres de
// modelo (que quedaría vieja con cada versión):
//
//   - **Ollama** lo informa en `capabilities` de /api/show («vision»).
//   - **Anthropic** lo informa en la ficha del modelo (`image_input`,
//     `pdf_input`), la misma consulta que ya se hace para el pensamiento.
//   - **OpenRouter** lo informa en /models (`architecture.input_modalities`).
//   - **Cualquier otro servidor compatible con OpenAI** no lo dice: se supone
//     que sí y se avisa — es mejor dejar que el servidor conteste que negarle a
//     la persona algo que quizá funcione.
//
// Known separa lo que el proveedor INFORMÓ de lo que se supone: con Known en
// false un «no» nunca bloquea, solo se avisa.

// AttachCaps es lo que un modelo acepta como adjunto, además del texto (que
// siempre entra: se pega dentro del mensaje).
type AttachCaps struct {
	Images bool
	PDF    bool
	// Known es true cuando el proveedor lo informó; false cuando es una suposición.
	Known bool
	// Note explica el porqué cuando conviene (idioma de la interfaz). Vacío si
	// no hay nada que aclarar.
	Note string
}

// AttachCapper lo implementan los clientes que saben decir qué adjuntos acepta
// un modelo.
type AttachCapper interface {
	AttachCaps(ctx context.Context, model string) AttachCaps
}

// AttachCapsOf pregunta al cliente. Un cliente que no sabe decirlo (un
// envoltorio, un doble de prueba) se trata como un servidor compatible con
// OpenAI sin información: imágenes supuestas, PDF no.
func AttachCapsOf(ctx context.Context, c Client, model string) AttachCaps {
	if ac, ok := c.(AttachCapper); ok {
		return ac.AttachCaps(ctx, model)
	}
	return assumedOpenAICaps()
}

func assumedOpenAICaps() AttachCaps {
	return AttachCaps{Images: true, Note: i18n.T(i18n.Msg{
		ES: "El servidor no informa si el modelo acepta imágenes: se envían igual y el modelo responde (o rechaza). Los PDF no se pueden mandar a este tipo de servidor.",
		EN: "The server does not say whether the model accepts images: they are sent anyway and the model answers (or refuses). PDFs cannot be sent to this kind of server.",
	})}
}

// attachCapsTTL es cuánto se recuerda lo que un servidor dijo de un modelo. Es
// corto porque un modelo de Ollama se puede volver a bajar (otra versión, otras
// capacidades) y el costo de preguntar de nuevo es una llamada local.
const attachCapsTTL = 10 * time.Minute

type attachCapsEntry struct {
	caps AttachCaps
	at   time.Time
}

// attachCapsCache recuerda las capacidades por tipo+URL+modelo. El cliente se
// arma de nuevo en cada turno, así que sin esto cada adjunto pagaría una
// consulta. Solo se guardan respuestas del proveedor: un fallo se reintenta.
var attachCapsCache sync.Map

func cachedAttachCaps(key string) (AttachCaps, bool) {
	if v, ok := attachCapsCache.Load(key); ok {
		if e := v.(attachCapsEntry); time.Since(e.at) < attachCapsTTL {
			return e.caps, true
		}
	}
	return AttachCaps{}, false
}

func storeAttachCaps(key string, caps AttachCaps) {
	attachCapsCache.Store(key, attachCapsEntry{caps: caps, at: time.Now()})
}

// --- Ollama --------------------------------------------------------------------

// AttachCaps de Ollama: «vision» en las capacidades de /api/show.
func (c *ollamaClient) AttachCaps(ctx context.Context, model string) AttachCaps {
	key := "ollama|" + c.base + "|" + model
	if caps, ok := cachedAttachCaps(key); ok {
		return caps
	}
	d, err := c.ShowModel(ctx, model)
	if err != nil {
		// Sin poder consultar (el modelo no está, el servidor no contesta) no
		// hay base para negar nada: el chat mismo dirá qué pasa.
		return AttachCaps{Images: true, Note: i18n.T(i18n.Msg{
			ES: "No se pudo consultar a Ollama si el modelo ve imágenes (%s): se envían igual.",
			EN: "Could not ask Ollama whether the model can see images (%s): they are sent anyway.",
		}, trimSnippet(err.Error(), nil))}
	}
	caps := AttachCaps{Known: true}
	for _, cp := range d.Capabilities {
		if strings.EqualFold(cp, "vision") {
			caps.Images = true
		}
	}
	if !caps.Images {
		caps.Note = i18n.T(i18n.Msg{
			ES: "El modelo %s no tiene visión según Ollama: no acepta imágenes. Los PDF no se pueden mandar a Ollama.",
			EN: "The model %s has no vision according to Ollama: it does not accept images. PDFs cannot be sent to Ollama.",
		}, model)
	} else {
		caps.Note = i18n.T(i18n.Msg{
			ES: "Los PDF no se pueden mandar a Ollama; los archivos de texto sí.",
			EN: "PDFs cannot be sent to Ollama; text files can.",
		})
	}
	storeAttachCaps(key, caps)
	return caps
}

// --- Anthropic -----------------------------------------------------------------

// AttachCaps de Anthropic: la ficha del modelo (image_input, pdf_input), la
// misma que ya consulta capsFor para el pensamiento y que queda en su caché.
func (c *anthropicClient) AttachCaps(ctx context.Context, model string) AttachCaps {
	if strings.TrimSpace(model) == "" {
		model = anthropicDefaultModel
	}
	k := c.capsFor(ctx, model)
	caps := AttachCaps{Images: k.image, PDF: k.pdf, Known: k.live}
	switch {
	case !k.live:
		caps.Note = i18n.T(i18n.Msg{
			ES: "No se pudo consultar a Anthropic qué adjuntos admite el modelo: se supone que acepta imágenes y PDF.",
			EN: "Could not ask Anthropic which attachments the model accepts: images and PDFs are assumed.",
		})
	case !k.image && !k.pdf:
		caps.Note = i18n.T(i18n.Msg{ES: "El modelo %s no acepta imágenes ni PDF.", EN: "The model %s accepts neither images nor PDFs."}, model)
	case !k.image:
		caps.Note = i18n.T(i18n.Msg{ES: "El modelo %s no acepta imágenes.", EN: "The model %s does not accept images."}, model)
	case !k.pdf:
		caps.Note = i18n.T(i18n.Msg{ES: "El modelo %s no acepta PDF.", EN: "The model %s does not accept PDFs."}, model)
	}
	return caps
}

// --- Compatible con OpenAI ------------------------------------------------------

// isOpenRouter dice si la URL base es la de OpenRouter, el único servidor
// compatible con OpenAI conocido que informa las modalidades de cada modelo.
func isOpenRouter(base string) bool {
	u, err := url.Parse(base)
	if err != nil {
		return false
	}
	h := strings.ToLower(u.Hostname())
	return h == "openrouter.ai" || strings.HasSuffix(h, ".openrouter.ai")
}

// AttachCaps de un servidor compatible con OpenAI: OpenRouter informa las
// modalidades de entrada de cada modelo; cualquier otro no, y ahí las imágenes
// se suponen. El PDF nunca: este cliente no codifica archivos, y extraer el
// texto de un PDF es otra dependencia.
func (c *openaiClient) AttachCaps(ctx context.Context, model string) AttachCaps {
	if !isOpenRouter(c.base) {
		return assumedOpenAICaps()
	}
	mods, ok := c.openRouterModalities(ctx)
	in, found := mods[model]
	if !ok || !found {
		caps := assumedOpenAICaps()
		caps.Note = i18n.T(i18n.Msg{
			ES: "OpenRouter no informó las modalidades del modelo %s: se supone que acepta imágenes. Los PDF no se pueden mandar por este camino.",
			EN: "OpenRouter did not report the modalities of the model %s: images are assumed. PDFs cannot be sent this way.",
		}, model)
		return caps
	}
	caps := AttachCaps{Known: true}
	for _, m := range in {
		if strings.EqualFold(m, "image") {
			caps.Images = true
		}
	}
	if caps.Images {
		caps.Note = i18n.T(i18n.Msg{ES: "Los PDF no se pueden mandar por este camino; los archivos de texto sí.", EN: "PDFs cannot be sent this way; text files can."})
	} else {
		caps.Note = i18n.T(i18n.Msg{
			ES: "El modelo %s no acepta imágenes según OpenRouter (entrada: %s). Los PDF no se pueden mandar por este camino.",
			EN: "The model %s does not accept images according to OpenRouter (input: %s). PDFs cannot be sent this way.",
		}, model, strings.Join(in, ", "))
	}
	return caps
}

// openRouterModalities trae las modalidades de entrada de TODOS los modelos de
// OpenRouter en una sola llamada (/models) y las recuerda: un turno con un
// adjunto no debería pagar una descarga de ~300 modelos cada vez.
func (c *openaiClient) openRouterModalities(ctx context.Context) (map[string][]string, bool) {
	key := "openrouter|" + c.base
	if v, ok := attachCapsCache.Load(key); ok {
		if e := v.(modalitiesEntry); time.Since(e.at) < attachCapsTTL {
			return e.byModel, true
		}
	}
	ctx, cancel := context.WithTimeout(ctx, controlTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+"/models", nil)
	if err != nil {
		return nil, false
	}
	resp, err := c.do(req)
	if err != nil {
		return nil, false
	}
	defer resp.Body.Close()
	var out struct {
		Data []struct {
			ID           string `json:"id"`
			Architecture struct {
				InputModalities []string `json:"input_modalities"`
				// Modality es la forma vieja: «text+image->text».
				Modality string `json:"modality"`
			} `json:"architecture"`
		} `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 16<<20)).Decode(&out); err != nil {
		return nil, false
	}
	byModel := make(map[string][]string, len(out.Data))
	for _, m := range out.Data {
		if m.ID == "" {
			continue
		}
		in := m.Architecture.InputModalities
		if len(in) == 0 && m.Architecture.Modality != "" {
			left, _, _ := strings.Cut(m.Architecture.Modality, "->")
			in = strings.Split(left, "+")
		}
		if len(in) == 0 {
			continue // sin dato: que quede como «no informado», no como «solo texto»
		}
		byModel[m.ID] = in
	}
	attachCapsCache.Store(key, modalitiesEntry{byModel: byModel, at: time.Now()})
	return byModel, true
}

type modalitiesEntry struct {
	byModel map[string][]string
	at      time.Time
}

var (
	_ AttachCapper = (*ollamaClient)(nil)
	_ AttachCapper = (*openaiClient)(nil)
	_ AttachCapper = (*anthropicClient)(nil)
)
