package main

import (
	"context"
	"errors"
	"net/url"
	"sync"
	"time"

	"mini-tools/backend/agentchat"
	"mini-tools/backend/i18n"
	"mini-tools/backend/llm"
	"mini-tools/backend/vault"
)

// Chequeo previo de un servidor de modelos.
//
// Un servidor remoto se apaga, cambia de IP o queda detrás de una VPN caída, y
// sin chequeo lo que se ve es un turno que arranca, gira un buen rato y falla
// con un mensaje de red. Por eso antes de CADA turno contra un `llm:<id>`
// (SendAgentChat, AgentAsk*, AskAgentOnce) se hace una pregunta barata —
// Ollama: GET /api/version; compatibles con OpenAI: GET {base}/models— con
// 4s de plazo. Si falla, el turno ni empieza: no hay evento de inicio ni fila
// en el historial, solo el error con el nombre del servidor, su host y la
// causa.
//
// Para no sumar una ida y vuelta a cada mensaje, un chequeo exitoso vale
// modelHealthTTL (30s) y se renueva solo con cada respuesta real del chat. Un
// fallo NO se cachea: el chequeo siguiente vuelve a preguntar, que es lo que
// se quiere cuando el usuario enciende el servidor y reintenta.

const (
	modelHealthTTL     = 30 * time.Second
	modelHealthTimeout = 4 * time.Second
)

type modelHealthEntry struct {
	probe ModelServerProbe
	// full dice si el chequeo trajo también la lista de modelos. El chequeo
	// previo de Ollama solo pide la versión; ModelServerHealth necesita los
	// modelos y no se conforma con una entrada que no los tiene.
	full bool
	at   time.Time
}

// modelHealthCache es el caché de chequeos, por id de servidor. Su valor cero
// está listo para usar y es seguro entre goroutines.
type modelHealthCache struct {
	mu      sync.Mutex
	entries map[string]modelHealthEntry
	// gen se incrementa al invalidar un servidor. Un chequeo que arrancó antes
	// no puede guardar su resultado después: lo hizo con la configuración
	// vieja (otra URL, otro token) y daría por sano lo que ya no es lo mismo.
	gen map[string]uint64
	now func() time.Time // nil = time.Now (los tests lo reemplazan)
}

func (c *modelHealthCache) clock() time.Time {
	if c.now != nil {
		return c.now()
	}
	return time.Now()
}

// get devuelve el chequeo exitoso vigente. needFull exige que traiga modelos.
func (c *modelHealthCache) get(id string, needFull bool) (ModelServerProbe, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[id]
	if !ok || c.clock().Sub(e.at) >= modelHealthTTL || (needFull && !e.full) {
		return ModelServerProbe{}, false
	}
	return e.probe, true
}

// begin marca el comienzo de un chequeo y devuelve la generación contra la
// que se va a validar el resultado.
func (c *modelHealthCache) begin(id string) uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.gen[id]
}

// put guarda un chequeo exitoso, salvo que el servidor se haya invalidado
// desde begin.
func (c *modelHealthCache) put(id string, gen uint64, p ModelServerProbe, full bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.gen[id] != gen {
		return
	}
	if c.entries == nil {
		c.entries = map[string]modelHealthEntry{}
	}
	c.entries[id] = modelHealthEntry{probe: p, full: full, at: c.clock()}
}

// touch renueva la vigencia tras una respuesta real del chat: si el servidor
// acaba de contestar un turno entero, está sano, y preguntárselo de nuevo es
// ruido. Conserva lo que ya se sabía (versión, modelos).
func (c *modelHealthCache) touch(id string, gen uint64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.gen[id] != gen {
		return
	}
	if c.entries == nil {
		c.entries = map[string]modelHealthEntry{}
	}
	now := c.clock()
	e := c.entries[id]
	e.probe.OK = true
	e.probe.Error = ""
	e.probe.CheckedAt = now.UnixMilli()
	if e.probe.Models == nil {
		e.probe.Models = []string{}
	}
	e.at = now
	c.entries[id] = e
}

// invalidate olvida el servidor (se guardó, se borró, o falló una conexión en
// pleno turno) e impide que un chequeo en vuelo guarde su resultado.
func (c *modelHealthCache) invalidate(id string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.entries, id)
	if c.gen == nil {
		c.gen = map[string]uint64{}
	}
	c.gen[id]++
}

// runProbe pregunta al servidor. full agrega la lista de modelos al chequeo de
// Ollama (el de OpenAI ya es esa lista: no tiene endpoint de versión).
func runProbe(ctx context.Context, kind string, client llm.Client, full bool) (ModelServerProbe, error) {
	start := time.Now()
	finish := func(p ModelServerProbe, err error) (ModelServerProbe, error) {
		p.LatencyMs = time.Since(start).Milliseconds()
		p.CheckedAt = time.Now().UnixMilli()
		if p.Models == nil {
			p.Models = []string{}
		}
		if err != nil {
			p.OK = false
			p.Error = err.Error()
			return p, err
		}
		p.OK = true
		return p, nil
	}

	var p ModelServerProbe
	if kind == vault.ModelServerOllama {
		v, err := client.Version(ctx)
		if err != nil {
			return finish(p, err)
		}
		p.Version = v
		if full {
			models, err := client.Models(ctx)
			if err != nil {
				return finish(p, err)
			}
			p.Models = models
		}
		return finish(p, nil)
	}
	models, err := client.Models(ctx)
	if err != nil {
		return finish(p, err)
	}
	p.Models = models
	return finish(p, nil)
}

// serverHost es el host:puerto de la URL, lo que se muestra en un error. No se
// muestra la URL completa: puede llevar una ruta o credenciales.
func serverHost(raw string) string {
	if u, err := url.Parse(raw); err == nil && u.Host != "" {
		return u.Host
	}
	return raw
}

// serverUnreachableError es el error del chequeo previo: dice qué servidor,
// en qué host y por qué, más qué hacer.
func serverUnreachableError(m vault.ModelServer, cause error) error {
	hint := i18n.Msg{ES: "Revisá que esté encendido y accesible desde esta máquina.", EN: "Check that it is on and reachable from this machine."}
	var se *llm.StatusError
	switch {
	case llm.IsTLSError(cause):
		// El mensaje de TLS ya dice qué hacer.
		return i18n.Errorf(i18n.Msg{
			ES: "No se pudo usar el servidor «%s» (%s): %w",
			EN: "Could not use the server «%s» (%s): %w",
		}, m.Name, serverHost(m.BaseURL), cause)
	case errors.As(cause, &se) && (se.Status == 401 || se.Status == 403):
		hint = i18n.Msg{ES: "Revisá el token y las cabeceras del servidor.", EN: "Check the server's token and headers."}
	}
	return i18n.Errorf(i18n.Msg{
		ES: "No se pudo usar el servidor «%s» (%s): %w. %s",
		EN: "Could not use the server «%s» (%s): %w. %s",
	}, m.Name, serverHost(m.BaseURL), cause, i18n.T(hint))
}

// healthTrackedClient renueva el caché con cada respuesta real y lo invalida
// si la conexión se cae en pleno turno.
type healthTrackedClient struct {
	llm.Client
	id    string
	gen   uint64
	cache *modelHealthCache
}

func (c *healthTrackedClient) Chat(ctx context.Context, req llm.ChatRequest, onDelta func(llm.Delta)) (llm.ChatResult, error) {
	res, err := c.Client.Chat(ctx, req, onDelta)
	switch {
	case err == nil:
		c.cache.touch(c.id, c.gen)
	case llm.IsRetryable(err):
		// El próximo turno tiene que volver a preguntar antes de confiar.
		c.cache.invalidate(c.id)
	}
	return res, err
}

// llmClientForTurn es llmClientFor con el chequeo previo: lo que usan los
// caminos que arrancan un turno. Si el servidor no responde devuelve el error
// y no hay cliente, así que nadie llega a registrar nada.
func (a *App) llmClientForTurn(agentID string) (llm.Client, error) {
	m, client, err := a.llmServer(agentID)
	if err != nil {
		return nil, err
	}
	gen := a.modelHealth.begin(m.ID)
	if _, ok := a.modelHealth.get(m.ID, false); !ok {
		ctx, cancel := context.WithTimeout(context.Background(), modelHealthTimeout)
		defer cancel()
		probe, err := runProbe(ctx, m.Kind, client, false)
		if err != nil {
			return nil, serverUnreachableError(m, err)
		}
		a.modelHealth.put(m.ID, gen, probe, false)
	}
	return &healthTrackedClient{Client: client, id: m.ID, gen: gen, cache: &a.modelHealth}, nil
}

// ModelServerHealth dice cómo está un servidor guardado, usando el caché: un
// chequeo exitoso de menos de 30s se devuelve tal cual (con su LatencyMs y
// CheckedAt originales); si es más viejo, o no hay, se hace uno nuevo.
// Un servidor caído no es un error de la llamada: viaja en Error con OK=false.
// Los fallos no se cachean.
func (a *App) ModelServerHealth(id string) (ModelServerProbe, error) {
	if err := a.requireUnlocked(); err != nil {
		return ModelServerProbe{}, err
	}
	m, client, err := a.llmServer(agentchat.LLMPrefix + id)
	if err != nil {
		return ModelServerProbe{Models: []string{}, Error: err.Error(), CheckedAt: time.Now().UnixMilli()}, nil
	}
	if p, ok := a.modelHealth.get(id, true); ok {
		return p, nil
	}
	gen := a.modelHealth.begin(id)
	ctx, cancel := context.WithTimeout(context.Background(), modelHealthTimeout)
	defer cancel()
	probe, err := runProbe(ctx, m.Kind, client, true)
	if err == nil {
		a.modelHealth.put(id, gen, probe, true)
	}
	return probe, nil
}
