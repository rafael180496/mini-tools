package agentlimits

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Consulta de límites AL PROPIO CLI, para los que no dejan el dato en el disco.
//
// # Por qué esto sí y no antes
//
// Antigravity no cachea su cuota en ningún archivo —se revisó entero
// `~/.gemini/antigravity-cli/`, y lo único que hay del tema son líneas de
// `quota_manager.go` diciendo que refrescó, sin los valores—. La conclusión
// anterior fue "no se puede saber sin reimplementar su gRPC privado", y eso
// seguía siendo cierto para el disco.
//
// Lo que cambia acá es de dónde se saca: **se le pregunta al propio CLI**, con
// el mismo comando que escribiría el usuario. `agy --print "/usage"` corre el
// slash command sin abrir la TUI, y con `--output-format json` devuelve la
// respuesta ESTRUCTURADA —grupos de modelos, cada uno con sus ventanas
// (semanal y de cinco horas), la fracción que queda y cuándo se reinicia—. No
// se imita ningún protocolo interno ni se scrapea una pantalla: se usa una
// interfaz pública del CLI, la misma que documenta su propia ayuda.
//
// # Por qué es a pedido y no automático
//
// Cuesta un subproceso y unos segundos (arranca su language server y le
// pregunta al servidor), y puede fallar por red — se lo vio devolver
// `context deadline exceeded` y al reintentar contestar bien. Un panel que
// dispara eso solo cada vez que se abre gasta tiempo del usuario sin que nadie
// lo haya pedido; por eso lo dispara un botón, el resultado queda cacheado en
// memoria y la UI dice de cuándo es.
//
// **No consume cuota**: el propio CLI informa `usage.total_tokens: 0` en la
// respuesta de este comando — es una consulta de estado, no un turno de modelo.

// queryTimeout acota la consulta. Generoso a propósito: el CLI arranca su
// language server, se autentica y recién ahí pregunta. Lo que no puede es
// quedarse colgado para siempre detrás de un botón.
const queryTimeout = 90 * time.Second

// Queryable informa si a este agente se le puede preguntar por CLI. La UI lo
// usa para ofrecer el botón solo donde hace algo.
func Queryable(agentID string) bool {
	return agentID == "antigravity"
}

// QuerySpec es todo lo que hace falta para lanzar el CLI. Se pasa desde la capa
// de app en vez de resolverlo acá: este paquete no conoce el catálogo de
// agentes ni el vault, y así se mantiene igual de testeable que los lectores de
// disco.
type QuerySpec struct {
	AgentID string
	// Argv es el ejecutable ya resuelto a ruta absoluta (más el shell de
	// Windows cuando hace falta), tal cual lo arma agents.Launcher.
	Argv []string
	Env  []string
	Cwd  string
}

// Query le pregunta a un CLI por sus límites y cachea el resultado.
func Query(ctx context.Context, spec QuerySpec) (AgentLimits, error) {
	if !Queryable(spec.AgentID) {
		return AgentLimits{}, fmt.Errorf("agentlimits: a %s no se le puede preguntar el límite por línea de comandos", spec.AgentID)
	}
	if len(spec.Argv) == 0 {
		return AgentLimits{}, fmt.Errorf("agentlimits: falta el ejecutable de %s", spec.AgentID)
	}

	l, err := queryAntigravity(ctx, spec)
	if err != nil {
		return AgentLimits{}, err
	}
	remember(l)
	return l, nil
}

// queryAntigravity corre `agy --print "/usage" --output-format json`.
func queryAntigravity(ctx context.Context, spec QuerySpec) (AgentLimits, error) {
	ctx, cancel := context.WithTimeout(ctx, queryTimeout)
	defer cancel()

	args := append(append([]string{}, spec.Argv[1:]...), "--print", "/usage", "--output-format", "json")
	cmd := exec.CommandContext(ctx, spec.Argv[0], args...)
	cmd.Env = spec.Env
	cmd.Dir = spec.Cwd

	out, err := cmd.Output()
	if err != nil {
		var ee *exec.ExitError
		if ok := asExitError(err, &ee); ok && len(ee.Stderr) > 0 {
			return AgentLimits{}, fmt.Errorf("agentlimits: %s no pudo informar su cuota: %s", spec.AgentID, firstLine(string(ee.Stderr)))
		}
		return AgentLimits{}, fmt.Errorf("agentlimits: no se pudo consultar la cuota de %s: %w", spec.AgentID, err)
	}

	var doc struct {
		Status   string `json:"status"`
		Response string `json:"response"`
		Error    string `json:"error"`
		Command  struct {
			Data struct {
				Description string `json:"description"`
				Groups      []struct {
					Name        string `json:"name"`
					Description string `json:"description"`
					Buckets     []struct {
						ID                string   `json:"id"`
						Name              string   `json:"name"`
						Window            string   `json:"window"`
						RemainingFraction *float64 `json:"remaining_fraction"`
						ResetTime         string   `json:"reset_time"`
					} `json:"buckets"`
				} `json:"groups"`
			} `json:"data"`
		} `json:"command"`
	}
	if err := json.Unmarshal(trimToJSON(out), &doc); err != nil {
		return AgentLimits{}, fmt.Errorf("agentlimits: no se entendió la respuesta de %s: %w", spec.AgentID, err)
	}
	if doc.Status == "ERROR" || doc.Error != "" {
		// El error del CLI se pasa tal cual: dice si fue la red, la sesión o la
		// cuota, y parafrasearlo solo borra la parte accionable.
		return AgentLimits{}, fmt.Errorf("agentlimits: %s no pudo informar su cuota: %s", spec.AgentID, firstLine(doc.Error))
	}

	l := AgentLimits{
		Agent:      spec.AgentID,
		Source:     strings.Join(append(spec.Argv, "--print", "/usage"), " "),
		MeasuredAt: time.Now().Format(time.RFC3339),
	}

	for _, g := range doc.Command.Data.Groups {
		for _, b := range g.Buckets {
			if b.RemainingFraction == nil {
				continue
			}
			// El CLI informa lo que QUEDA; el resto de esta pantalla habla de lo
			// usado. Se convierte acá, una sola vez, en vez de dejar dos
			// convenciones conviviendo en la UI.
			used := (1 - *b.RemainingFraction) * 100
			l.Windows = append(l.Windows, Window{
				Kind:     antigravityKind(b.Window),
				Label:    groupLabel(g.Name) + " · " + antigravityWindowLabel(b.Window),
				Detail:   strings.TrimSpace(g.Description),
				Percent:  math.Max(0, math.Min(100, used)),
				ResetsAt: b.ResetTime,
			})
		}
	}

	// Respaldo: una versión del CLI que no mande el bloque estructurado sigue
	// imprimiendo el mismo dato como texto con tabulaciones.
	if len(l.Windows) == 0 {
		l.Windows = parseAntigravityText(doc.Response)
	}
	if len(l.Windows) == 0 {
		return AgentLimits{}, fmt.Errorf("agentlimits: %s no devolvió ninguna ventana de límite", spec.AgentID)
	}

	// La que manda es la más consumida: es la primera que va a cortar el
	// trabajo, sin importar cuál sea su ventana.
	worst := 0
	for i, w := range l.Windows {
		if w.Percent > l.Windows[worst].Percent {
			worst = i
		}
	}
	l.Windows[worst].Active = true
	l.Known = true
	l.Queryable = true
	// Aclaración imprescindible: Antigravity reparte SU cuota entre grupos de
	// modelos, y uno de esos grupos se llama "Claude and GPT models". Sin decir
	// esto, esa fila adentro de la tarjeta de Antigravity se lee como consumo
	// de Claude Code o de Codex, que son otras cuentas y otros límites.
	l.Note = "Son los grupos de modelos que sirve Antigravity con tu plan de Antigravity — no son cuotas de Anthropic ni de OpenAI."
	return l, nil
}

// parseAntigravityText lee la salida de texto: una línea por ventana, con
// grupo, nombre, porcentaje RESTANTE y fecha de reinicio separados por tabs.
func parseAntigravityText(response string) []Window {
	out := []Window{}
	for _, line := range strings.Split(response, "\n") {
		cols := strings.Split(strings.TrimRight(line, "\r"), "\t")
		if len(cols) < 3 {
			continue
		}
		pct, err := strconv.ParseFloat(strings.TrimSuffix(strings.TrimSpace(cols[2]), "%"), 64)
		if err != nil {
			continue
		}
		name := strings.TrimSpace(cols[1])
		window := "weekly"
		if strings.Contains(strings.ToLower(name), "five hour") || strings.Contains(strings.ToLower(name), "5") {
			window = "5h"
		}
		w := Window{
			Kind:    antigravityKind(window),
			Label:   groupLabel(cols[0]) + " · " + antigravityWindowLabel(window),
			Percent: math.Max(0, math.Min(100, 100-pct)),
		}
		if len(cols) > 3 {
			w.ResetsAt = strings.TrimSpace(cols[3])
		}
		out = append(out, w)
	}
	return out
}

// groupLabel acorta el nombre del grupo tal cual lo manda el CLI ("Gemini
// Models", "Claude and GPT models"). La palabra "models" no distingue nada
// —todos son grupos de modelos— y en una columna angosta es justo lo que hace
// que el nombre se corte antes de decir cuál es.
func groupLabel(name string) string {
	out := strings.TrimSpace(name)
	for _, suffix := range []string{" models", " Models"} {
		out = strings.TrimSuffix(out, suffix)
	}
	return strings.ReplaceAll(out, " and ", " y ")
}

func antigravityKind(window string) string {
	switch strings.ToLower(window) {
	case "5h", "five_hour", "fivehour":
		return "session"
	case "weekly", "week":
		return "weekly"
	}
	return windowKind(0)
}

func antigravityWindowLabel(window string) string {
	switch strings.ToLower(window) {
	case "5h", "five_hour", "fivehour":
		return "5 h"
	case "weekly", "week":
		return "semana"
	}
	return window
}

// --- Caché en memoria ------------------------------------------------------
//
// Dura lo que dura la app. No se persiste a propósito: es un dato que envejece
// mal —el porcentaje de la semana pasada no dice nada— y guardarlo daría la
// impresión de que la app lo sabe cuando en realidad habría que volver a
// preguntar. Con el caché en memoria, abrir el panel dos veces no lanza dos
// subprocesos, y reiniciar la app pide un clic.
var (
	cacheMu sync.RWMutex
	cache   = map[string]AgentLimits{}
)

func remember(l AgentLimits) {
	cacheMu.Lock()
	defer cacheMu.Unlock()
	cache[l.Agent] = l
}

// cachedFor devuelve lo último que contestó el CLI de ese agente en esta
// sesión de la app.
func cachedFor(agentID string) (AgentLimits, bool) {
	cacheMu.RLock()
	defer cacheMu.RUnlock()
	l, ok := cache[agentID]
	return l, ok
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return strings.TrimSpace(s[:i])
	}
	return strings.TrimSpace(s)
}

// trimToJSON se queda con el objeto JSON de la salida. Un CLI puede imprimir
// una línea de aviso antes del JSON (una actualización disponible, por
// ejemplo) y eso no puede romper la lectura.
func trimToJSON(out []byte) []byte {
	i := strings.IndexByte(string(out), '{')
	if i <= 0 {
		return out
	}
	return out[i:]
}

func asExitError(err error, target **exec.ExitError) bool {
	ee, ok := err.(*exec.ExitError)
	if ok {
		*target = ee
	}
	return ok
}
