package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"sort"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"mini-tools/backend/agentchat"
	"mini-tools/backend/i18n"
	"mini-tools/backend/llm"
	"mini-tools/backend/vault"
)

// Administración de modelos de un servidor (Utilidades → Modelos): listar,
// ver el detalle, descargar (pull), borrar y soltar de la memoria.
//
// Usa el mismo cliente que el chat (llmServer): el token, las cabeceras
// propias y la preferencia de TLS del servidor guardado salen del vault acá y
// no cruzan hacia el frontend. Todos los métodos pasan por requireUnlocked.
//
// Solo Ollama expone estas operaciones. Un servidor compatible con OpenAI
// permite listar y nada más: el resto responde un *llm.UnsupportedError con
// el motivo, y la interfaz ya esconde esas acciones.

// modelPullEventPrefix es el prefijo del evento de Wails de una descarga: el
// evento completo es `model-pull:<pullID>`.
const modelPullEventPrefix = "model-pull:"

// modelPullKeep es cuánto se recuerda una descarga terminada, para que quien
// abre la pestaña después todavía vea cómo terminó.
const modelPullKeep = 10 * time.Minute

// modelPullEmitEvery acota los eventos de progreso: Ollama manda una línea por
// cada trozo de unos pocos KB, decenas por segundo en una descarga rápida, y
// la interfaz no necesita redibujar más que ~10 veces por segundo.
const modelPullEmitEvery = 100 * time.Millisecond

// ModelPullEvent es el estado de una descarga: el payload del evento
// `model-pull:<pullID>` y lo que devuelve ModelServerPulls.
type ModelPullEvent struct {
	PullID   string `json:"pullId"`
	ServerID string `json:"serverId"`
	Model    string `json:"model"`
	// Status es el texto del servidor («pulling manifest», «pulling <digest>»,
	// «verifying sha256 digest», «success»).
	Status string `json:"status"`
	// Completed y Total son bytes, sumando todas las capas del modelo.
	// Total es 0 hasta que el servidor anuncia el tamaño de la primera capa.
	Completed int64   `json:"completed"`
	Total     int64   `json:"total"`
	Percent   float64 `json:"percent"` // 0..100, no retrocede
	// Done es true en el último evento. Con Error vacío y Cancelled falso, la
	// descarga terminó bien.
	Done      bool   `json:"done"`
	Error     string `json:"error"`
	Cancelled bool   `json:"cancelled"`
	// StartedAt es unix ms.
	StartedAt int64 `json:"startedAt"`
}

type modelPull struct {
	ev         ModelPullEvent
	cancel     context.CancelFunc
	finishedAt time.Time
}

// modelPullRegistry lleva las descargas en curso y las recién terminadas. Su
// valor cero está listo para usar.
type modelPullRegistry struct {
	mu    sync.Mutex
	pulls map[string]*modelPull
	// emit sustituye a runtime.EventsEmit; solo lo fijan los tests, que no
	// tienen el contexto de la ventana.
	emit func(event string, data any)
	now  func() time.Time // nil = time.Now
}

func (r *modelPullRegistry) clock() time.Time {
	if r.now != nil {
		return r.now()
	}
	return time.Now()
}

// pruneLocked olvida las descargas terminadas hace más de modelPullKeep.
func (r *modelPullRegistry) pruneLocked() {
	for id, p := range r.pulls {
		if !p.finishedAt.IsZero() && r.clock().Sub(p.finishedAt) > modelPullKeep {
			delete(r.pulls, id)
		}
	}
}

// ModelServerModels lista los modelos del servidor: instalados en Ollama, los
// que expone /models en uno compatible con OpenAI.
func (a *App) ModelServerModels(serverID string) ([]llm.ManagedModel, error) {
	_, adm, err := a.modelAdmin(serverID)
	if err != nil {
		return nil, err
	}
	list, err := adm.ListModels(context.Background())
	if err != nil {
		return nil, err
	}
	if list == nil {
		list = []llm.ManagedModel{}
	}
	return list, nil
}

// ModelServerRunning lista los modelos cargados en memoria. En un servidor
// que no lo informa (compatible con OpenAI) devuelve una lista vacía: saber
// qué está cargado es un dato accesorio, no una acción que pueda fallar.
func (a *App) ModelServerRunning(serverID string) ([]llm.RunningModel, error) {
	_, adm, err := a.modelAdmin(serverID)
	if err != nil {
		return nil, err
	}
	list, err := adm.RunningModels(context.Background())
	if err != nil {
		if llm.IsUnsupported(err) {
			return []llm.RunningModel{}, nil
		}
		return nil, err
	}
	if list == nil {
		list = []llm.RunningModel{}
	}
	return list, nil
}

// ModelServerShowModel devuelve el detalle de un modelo instalado.
func (a *App) ModelServerShowModel(serverID, model string) (llm.ModelDetails, error) {
	name, err := llm.ValidateModelName(model)
	if err != nil {
		return llm.ModelDetails{}, err
	}
	_, adm, err := a.modelAdmin(serverID)
	if err != nil {
		return llm.ModelDetails{}, err
	}
	return adm.ShowModel(context.Background(), name)
}

// ModelServerDeleteModel borra el modelo del disco del servidor. Invalida el
// caché del servidor: la lista de modelos que sabía el chequeo ya no es esa.
func (a *App) ModelServerDeleteModel(serverID, model string) error {
	name, err := llm.ValidateModelName(model)
	if err != nil {
		return err
	}
	_, adm, err := a.modelAdmin(serverID)
	if err != nil {
		return err
	}
	defer a.modelHealth.invalidate(serverID)
	return adm.DeleteModel(context.Background(), name)
}

// ModelServerUnload descarga el modelo de la memoria del servidor, sin
// borrarlo.
func (a *App) ModelServerUnload(serverID, model string) error {
	name, err := llm.ValidateModelName(model)
	if err != nil {
		return err
	}
	_, adm, err := a.modelAdmin(serverID)
	if err != nil {
		return err
	}
	return adm.UnloadModel(context.Background(), name)
}

// ModelServerPull empieza a descargar un modelo en el servidor y devuelve el
// id de la descarga. Corre en segundo plano y publica su avance en el evento
// `model-pull:<pullID>` (ModelPullEvent); no se corta al cerrar la pestaña.
//
// El evento puede dispararse antes de que el frontend alcance a suscribirse
// (un nombre inexistente falla en milisegundos), así que ModelServerPulls
// devuelve el último estado de cada descarga para ponerse al día.
func (a *App) ModelServerPull(serverID, model string) (string, error) {
	name, err := llm.ValidateModelName(model)
	if err != nil {
		return "", err
	}
	m, adm, err := a.modelAdmin(serverID)
	if err != nil {
		return "", err
	}
	// Se rechaza ya y no dentro de la goroutine: un servidor que no sabe
	// descargar no debería devolver un id de una descarga que nunca existió.
	if m.Kind != vault.ModelServerOllama {
		return "", &llm.UnsupportedError{Kind: "OpenAI", Action: i18n.T(i18n.Msg{ES: "descargar modelos", EN: "pulling models"})}
	}

	reg := &a.modelPulls
	reg.mu.Lock()
	reg.pruneLocked()
	for _, p := range reg.pulls {
		if p.ev.ServerID == serverID && p.ev.Model == name && !p.ev.Done {
			reg.mu.Unlock()
			return "", i18n.Errorf(i18n.Msg{
				ES: "«%s» ya se está descargando en ese servidor",
				EN: "«%s» is already being pulled on that server",
			}, name)
		}
	}
	id, err := newPullID()
	if err != nil {
		reg.mu.Unlock()
		return "", err
	}
	parent := a.ctx
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithCancel(parent)
	p := &modelPull{
		ev: ModelPullEvent{
			PullID: id, ServerID: serverID, Model: name,
			Status: i18n.T(i18n.Msg{ES: "iniciando…", EN: "starting…"}), StartedAt: reg.clock().UnixMilli(),
		},
		cancel: cancel,
	}
	if reg.pulls == nil {
		reg.pulls = map[string]*modelPull{}
	}
	reg.pulls[id] = p
	reg.mu.Unlock()

	go a.runModelPull(ctx, p, adm)
	return id, nil
}

func newPullID() (string, error) {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// runModelPull descarga el modelo y publica el avance. Siempre termina con un
// evento Done (éxito, error o cancelación).
func (a *App) runModelPull(ctx context.Context, p *modelPull, adm llm.Admin) {
	reg := &a.modelPulls
	var tr llm.PullTracker
	var lastEmit time.Time
	var lastStatus string

	// publish guarda el estado y, si toca, lo emite. Los eventos de progreso
	// se espacian; el cambio de estado y el final salen siempre.
	publish := func(mutate func(ev *ModelPullEvent), force bool) {
		reg.mu.Lock()
		mutate(&p.ev)
		ev := p.ev
		now := reg.clock()
		send := force || ev.Status != lastStatus || now.Sub(lastEmit) >= modelPullEmitEvery
		if send {
			lastEmit, lastStatus = now, ev.Status
		}
		reg.mu.Unlock()
		if send {
			a.emitModelPull(ev)
		}
	}

	err := adm.PullModel(ctx, p.ev.Model, func(pp llm.PullProgress) {
		completed, total, pct := tr.Update(pp)
		publish(func(ev *ModelPullEvent) {
			if pp.Status != "" {
				ev.Status = pp.Status
			}
			ev.Completed, ev.Total, ev.Percent = completed, total, pct
		}, false)
	})

	// El servidor cambió (modelo nuevo, o uno a medias): el chequeo cacheado
	// no sabe de él. Se invalida también si falló: pudo dejar capas.
	a.modelHealth.invalidate(p.ev.ServerID)

	publish(func(ev *ModelPullEvent) {
		ev.Done = true
		switch {
		case err == nil:
			ev.Status = "success"
			ev.Percent = 100
			if ev.Total > 0 {
				ev.Completed = ev.Total
			}
		case errors.Is(err, context.Canceled) || ctx.Err() != nil:
			ev.Cancelled = true
			ev.Status = i18n.T(i18n.Msg{ES: "cancelada", EN: "cancelled"})
		default:
			ev.Error = err.Error()
		}
		p.finishedAt = reg.clock()
	}, true)
	p.cancel()
}

func (a *App) emitModelPull(ev ModelPullEvent) {
	event := modelPullEventPrefix + ev.PullID
	if a.modelPulls.emit != nil {
		a.modelPulls.emit(event, ev)
		return
	}
	if a.ctx != nil {
		runtime.EventsEmit(a.ctx, event, ev)
	}
}

// ModelServerCancelPull corta una descarga en curso. Lo ya descargado queda en
// el servidor: volver a pedir el mismo modelo continúa desde ahí.
func (a *App) ModelServerCancelPull(pullID string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	reg := &a.modelPulls
	reg.mu.Lock()
	p, ok := reg.pulls[pullID]
	active := ok && !p.ev.Done
	reg.mu.Unlock()
	if !active {
		return i18n.Errorf(i18n.Msg{ES: "esa descarga no está en curso", EN: "that pull is not in progress"})
	}
	p.cancel()
	return nil
}

// ModelServerPulls devuelve el último estado de las descargas en curso y de
// las terminadas hace poco, de la más vieja a la más nueva. Sirve para
// ponerse al día al abrir la pestaña y para no perder el evento de una
// descarga que falló antes de que la interfaz se suscribiera.
func (a *App) ModelServerPulls() ([]ModelPullEvent, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	reg := &a.modelPulls
	reg.mu.Lock()
	defer reg.mu.Unlock()
	reg.pruneLocked()
	out := make([]ModelPullEvent, 0, len(reg.pulls))
	for _, p := range reg.pulls {
		out = append(out, p.ev)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].StartedAt != out[j].StartedAt {
			return out[i].StartedAt < out[j].StartedAt
		}
		return out[i].PullID < out[j].PullID
	})
	return out, nil
}

// ModelServerDismissPull olvida una descarga terminada (el «quitar» de la
// lista). Una en curso no se toca: se cancela.
func (a *App) ModelServerDismissPull(pullID string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	reg := &a.modelPulls
	reg.mu.Lock()
	defer reg.mu.Unlock()
	if p, ok := reg.pulls[pullID]; ok && p.ev.Done {
		delete(reg.pulls, pullID)
	}
	return nil
}

// modelAdmin arma la administración del servidor guardado, con el token y las
// cabeceras descifrados.
func (a *App) modelAdmin(serverID string) (vault.ModelServer, llm.Admin, error) {
	if err := a.requireUnlocked(); err != nil {
		return vault.ModelServer{}, nil, err
	}
	m, client, err := a.llmServer(agentchat.LLMPrefix + serverID)
	if err != nil {
		return vault.ModelServer{}, nil, err
	}
	adm, ok := llm.AsAdmin(client)
	if !ok {
		return vault.ModelServer{}, nil, i18n.Errorf(i18n.Msg{ES: "este servidor no se puede administrar", EN: "this server cannot be managed"})
	}
	return m, adm, nil
}
