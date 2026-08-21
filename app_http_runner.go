package main

import (
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"mini-tools/backend/httpclient"
	"mini-tools/backend/vault"
)

// Runner de colección: mandar una colección o una carpeta entera, en orden
// (fase 9 de .claude/specs/http-client.md).
//
// **En orden y de a una, no en paralelo.** Una colección de pruebas es casi
// siempre una secuencia: login, después la petición que usa la sesión, después
// la que usa el id que devolvió la anterior. Correrlas en paralelo rompe eso y
// además dispara N sesiones simultáneas contra el servidor de alguien.
//
// **Qué se cuenta como pasar.** La petición salió y el servidor contestó con un
// código menor a 400. Los scripts `pm.test` NO se evalúan acá y la interfaz lo
// dice: esta aplicación no ejecuta JavaScript (se descartó incorporar un motor
// en la fase 5, +19,8 MB contra un techo de 80), los tests se guardan, viajan
// en el export y los corre Postman o newman. Un resumen "3 tests pasaron"
// calculado sobre scripts que nadie ejecutó sería una mentira con formato de
// informe.

// HTTPRunResult es el resultado de UNA petición dentro de una corrida.
type HTTPRunResult struct {
	ItemID string `json:"itemId"`
	Name   string `json:"name"`
	// Folder es la ruta de carpetas, para poder agrupar el informe.
	Folder     string `json:"folder"`
	Method     string `json:"method"`
	URL        string `json:"url"`
	Status     int    `json:"status"`
	StatusText string `json:"statusText"`
	DurationMs int64  `json:"durationMs"`
	SizeBytes  int64  `json:"sizeBytes"`
	// Passed es lo único que decide el color de la fila: salió y contestó
	// menos de 400.
	Passed bool `json:"passed"`
	// Error es el fallo de transporte, cuando la petición no llegó a contestar.
	Error string `json:"error,omitempty"`
	// Missing son las variables que ningún nivel definió. No hacen fallar la
	// corrida por sí solas —una URL con un `{{marcador}}` sin resolver
	// normalmente falla igual— pero explican POR QUÉ falló.
	Missing []string `json:"missing,omitempty"`
	// Skipped marca una petición que no se llegó a mandar porque la corrida se
	// canceló. Se informa como salteada y no como fallida: no es lo mismo.
	Skipped bool `json:"skipped,omitempty"`
}

// HTTPRunSummary es el informe completo.
type HTTPRunSummary struct {
	RunID      string          `json:"runId"`
	Collection string          `json:"collection"`
	// Environment es el nombre del entorno con el que se corrió, o "" si no
	// había ninguno. Va en el informe porque el mismo resumen contra otro
	// entorno significa otra cosa.
	Environment string          `json:"environment"`
	Total       int             `json:"total"`
	Passed      int             `json:"passed"`
	Failed      int             `json:"failed"`
	Skipped     int             `json:"skipped"`
	DurationMs  int64           `json:"durationMs"`
	Canceled    bool            `json:"canceled"`
	Results     []HTTPRunResult `json:"results"`
}

// HTTPRunEvent es el nombre del evento de progreso. Una corrida de treinta
// peticiones tarda, y un botón girando sin decir por cuál va no sirve.
//
// Payload: un HTTPRunResult por petición terminada, más `runId` para que la UI
// sepa si le habla a la corrida que está mostrando.
const HTTPRunEvent = "http:run"

// httpRuns registra las corridas en curso para poder cancelarlas.
var httpRuns = struct {
	sync.Mutex
	canceled map[string]bool
}{canceled: map[string]bool{}}

// HttpRunCollection manda todas las peticiones de una colección, o solo las de
// una carpeta si se pasa `folderID`.
func (a *App) HttpRunCollection(runID, collectionID, folderID string, delayMs int) (*HTTPRunSummary, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return a.runCollection(runID, collectionID, folderID, delayMs, func(payload map[string]any) {
		runtime.EventsEmit(a.ctx, HTTPRunEvent, payload)
	})
}

// runCollection es la corrida de verdad, con el emisor de progreso inyectado.
//
// Separado del binding para poder ejercitarlo sin el contexto de Wails:
// `runtime.EventsEmit` exige el contexto que entrega el ciclo de vida de la
// aplicación, así que una corrida que emita directo solo se puede probar con la
// ventana abierta — que es como no poder probarla.
func (a *App) runCollection(runID, collectionID, folderID string, delayMs int, emit func(map[string]any)) (*HTTPRunSummary, error) {

	// El registro se abre ANTES de leer la colección: si se abriera después,
	// un «Cortar» apretado en ese hueco no encontraría la corrida y se
	// perdería — y el usuario vería seguir corriendo algo que pidió parar.
	httpRuns.Lock()
	httpRuns.canceled[runID] = false
	httpRuns.Unlock()
	defer func() {
		httpRuns.Lock()
		delete(httpRuns.canceled, runID)
		httpRuns.Unlock()
	}()

	items, err := a.vault.ListHTTPItems(collectionID)
	if err != nil {
		return nil, err
	}
	nodes := walkHTTPTree(items, "", "")
	if folderID != "" {
		nodes = underFolder(items, nodes, folderID)
	}
	if len(nodes) == 0 {
		return nil, fmt.Errorf("app: no hay peticiones que correr acá")
	}

	summary := &HTTPRunSummary{
		RunID:       runID,
		Collection:  a.collectionName(collectionID),
		Environment: a.environmentName(collectionID),
		Total:       len(nodes),
		Results:     make([]HTTPRunResult, 0, len(nodes)),
	}

	started := time.Now()
	for i, node := range nodes {
		if a.runCanceled(runID) {
			summary.Canceled = true
			for _, rest := range nodes[i:] {
				res := HTTPRunResult{
					ItemID: rest.item.ID, Name: rest.item.Name, Folder: rest.folder,
					Method: rest.item.Method, URL: rest.item.URL, Skipped: true,
				}
				summary.Skipped++
				summary.Results = append(summary.Results, res)
			}
			break
		}

		res := a.runOne(runID, node)
		if res.Passed {
			summary.Passed++
		} else {
			summary.Failed++
		}
		summary.Results = append(summary.Results, res)
		emit(map[string]any{"runId": runID, "index": i, "total": len(nodes), "result": res})

		// La pausa entre peticiones existe para no parecer un ataque: treinta
		// peticiones seguidas sin respirar es exactamente lo que un WAF corta.
		if delayMs > 0 && i < len(nodes)-1 {
			time.Sleep(time.Duration(delayMs) * time.Millisecond)
		}
	}

	summary.DurationMs = time.Since(started).Milliseconds()
	return summary, nil
}

// HttpCancelRun corta una corrida entre peticiones.
//
// Entre peticiones y no en medio de una: la que está en vuelo se deja terminar
// porque ya salió — cortarla del lado del cliente no la deshace del lado del
// servidor, y dejaría el informe diciendo que no se mandó algo que sí se mandó.
func (a *App) HttpCancelRun(runID string) {
	httpRuns.Lock()
	defer httpRuns.Unlock()
	if _, ok := httpRuns.canceled[runID]; ok {
		httpRuns.canceled[runID] = true
	}
}

func (a *App) runCanceled(runID string) bool {
	httpRuns.Lock()
	defer httpRuns.Unlock()
	return httpRuns.canceled[runID]
}

// runOne manda una petición de la corrida por el MISMO camino que el botón
// Enviar: HttpSend resuelve variables, autenticación heredada, variables
// calculadas, cookies del entorno e historial. Un segundo camino de envío
// terminaría, tarde o temprano, comportándose distinto que el de la pestaña —
// y entonces el informe dejaría de decir algo sobre lo que pasa al mandarla a
// mano.
func (a *App) runOne(runID string, node treeNode) HTTPRunResult {
	res := HTTPRunResult{
		ItemID: node.item.ID,
		Name:   node.item.Name,
		Folder: node.folder,
		Method: strings.ToUpper(node.item.Method),
		URL:    node.item.URL,
	}

	built, err := a.HttpBuildRequest(node.item.ID)
	if err != nil {
		res.Error = err.Error()
		return res
	}
	if strings.TrimSpace(built.URL) == "" {
		res.Error = "la petición no tiene URL"
		return res
	}

	out, err := a.HttpSend(runID+"-"+node.item.ID, node.item.ID, *built)
	if err != nil {
		res.Error = err.Error()
		return res
	}
	res.Missing = out.Missing
	res.URL = out.SentURL
	if out.Error != "" {
		res.Error = out.Error
		return res
	}
	if out.Response != nil {
		res.Status = out.Response.Status
		res.StatusText = out.Response.StatusText
		res.DurationMs = out.Response.DurationMs
		res.SizeBytes = out.Response.SizeBytes
		res.Passed = out.Response.Status > 0 && out.Response.Status < 400
	}
	return res
}

// underFolder recorta la lista a lo que cuelga de una carpeta, incluidas sus
// subcarpetas.
func underFolder(items []vault.HTTPItem, nodes []treeNode, folderID string) []treeNode {
	inside := map[string]bool{folderID: true}
	// Varias pasadas porque los hijos pueden venir antes que su padre en la
	// lista plana; con el árbol de una colección real una o dos alcanzan, y el
	// tope evita quedarse dando vueltas si algún día hay un ciclo.
	for pass := 0; pass < len(items)+1; pass++ {
		grew := false
		for _, it := range items {
			if it.Kind == "folder" && inside[it.ParentID] && !inside[it.ID] {
				inside[it.ID] = true
				grew = true
			}
		}
		if !grew {
			break
		}
	}

	out := make([]treeNode, 0, len(nodes))
	for _, n := range nodes {
		if inside[n.item.ParentID] {
			out = append(out, n)
		}
	}
	return out
}

func (a *App) collectionName(collectionID string) string {
	cols, err := a.vault.ListHTTPCollections()
	if err != nil {
		return ""
	}
	for _, c := range cols {
		if c.ID == collectionID {
			return c.Name
		}
	}
	return ""
}

// environmentName es el nombre del entorno que se va a usar, para poder
// escribirlo en el informe.
func (a *App) environmentName(collectionID string) string {
	_, envID := a.scopesAndEnv(collectionID)
	if envID == "" {
		return ""
	}
	envs, err := a.vault.ListHTTPEnvironments()
	if err != nil {
		return ""
	}
	for _, e := range envs {
		if e.ID == envID {
			return e.Name
		}
	}
	return ""
}

// --- Cookies ------------------------------------------------------------------

// HttpCookies lista las cookies guardadas del entorno que se está usando con
// esa colección (o del tarro sin entorno).
func (a *App) HttpCookies(collectionID string) ([]httpclient.Cookie, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	_, envID := a.scopesAndEnv(collectionID)
	return a.httpRunner.Jars.List(envID), nil
}

// HttpClearCookies borra las cookies de un dominio, o todas las del entorno si
// `domain` viene vacío.
func (a *App) HttpClearCookies(collectionID, domain string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	_, envID := a.scopesAndEnv(collectionID)
	if domain == "" {
		a.httpRunner.Jars.Reset(envID)
		return nil
	}
	a.httpRunner.Jars.ClearDomain(envID, domain)
	return nil
}
