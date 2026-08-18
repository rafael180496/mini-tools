package agentlimits

import (
	"bufio"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// codexSessionFiles es cuántas sesiones recientes se miran hacia atrás
// buscando el último dato de límites.
//
// No alcanza con la más nueva: una sesión que se abrió y se cerró sin mandar
// nada no tiene ningún evento de límites, y quedarse ahí sería decir "no hay
// datos" teniendo el de la sesión anterior a mano.
const codexSessionFiles = 5

// codexLimits lee el último `rate_limits` que Codex haya escrito en sus
// sesiones (`~/.codex/sessions/AAAA/MM/DD/rollout-*.jsonl`).
//
// Ese bloque es lo que el servidor de OpenAI devuelve junto con cada respuesta:
// qué porcentaje de la ventana se lleva usado, cuánto dura la ventana y cuándo
// se reinicia. Igual que con Claude Code, el número lo calculó el proveedor; lo
// único que hace esta app es leer el más reciente y decir de cuándo es.
func codexLimits(home string) AgentLimits {
	root := filepath.Join(home, ".codex", "sessions")
	l := AgentLimits{Agent: "codex", Source: root}

	if _, err := os.Stat(root); err != nil {
		l.Note = "No hay sesiones de Codex en esta máquina."
		return l
	}

	files := recentRollouts(root, codexSessionFiles)
	if len(files) == 0 {
		l.Note = "Codex todavía no dejó ninguna sesión con datos de límites."
		return l
	}

	for _, f := range files {
		if ev := lastRateLimits(f); ev != nil {
			l.Source = f
			l.Plan = ev.Limits.PlanType
			l.MeasuredAt = ev.Timestamp
			for _, w := range []*codexWindow{ev.Limits.Primary, ev.Limits.Secondary} {
				if w == nil {
					continue
				}
				win := Window{
					Kind:    windowKind(w.WindowMinutes),
					Label:   "Ventana · " + windowLabel(w.WindowMinutes),
					Percent: w.UsedPercent,
				}
				if w.ResetsAt > 0 {
					win.ResetsAt = time.Unix(w.ResetsAt, 0).Format(time.RFC3339)
				}
				l.Windows = append(l.Windows, win)
			}
			if len(l.Windows) > 0 {
				// La ventana más corta es la que manda en la práctica: es la
				// que corta el trabajo primero.
				l.Windows[0].Active = true
				l.Known = true
				return l
			}
		}
	}

	l.Note = "Las sesiones de Codex de esta máquina no traen datos de límites todavía."
	return l
}

type codexWindow struct {
	UsedPercent   float64 `json:"used_percent"`
	WindowMinutes int     `json:"window_minutes"`
	ResetsAt      int64   `json:"resets_at"`
}

type codexEvent struct {
	Timestamp string `json:"timestamp"`
	Limits    struct {
		PlanType  string
		Primary   *codexWindow
		Secondary *codexWindow
	}
}

// lastRateLimits devuelve el último evento con límites de un archivo de sesión.
//
// Se recorre entero y se queda con el último en vez de leer desde el final: son
// archivos de una sesión, no de un historial completo, y el evento aparece en
// cada respuesta — el costo real es el de leer un archivo chico, no el de
// buscar hacia atrás en uno grande.
func lastRateLimits(path string) *codexEvent {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()

	var found *codexEvent
	sc := bufio.NewScanner(f)
	// Una línea de sesión lleva adentro el turno entero: el buffer por defecto
	// (64 KB) se queda corto y cortaría justo las líneas más informativas.
	sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	for sc.Scan() {
		line := sc.Bytes()
		if !strings.Contains(string(line), `"rate_limits"`) {
			continue
		}
		var doc struct {
			Timestamp string `json:"timestamp"`
			Payload   struct {
				RateLimits *struct {
					PlanType  string       `json:"plan_type"`
					Primary   *codexWindow `json:"primary"`
					Secondary *codexWindow `json:"secondary"`
				} `json:"rate_limits"`
			} `json:"payload"`
		}
		if err := json.Unmarshal(line, &doc); err != nil || doc.Payload.RateLimits == nil {
			continue
		}
		ev := &codexEvent{Timestamp: doc.Timestamp}
		ev.Limits.PlanType = doc.Payload.RateLimits.PlanType
		ev.Limits.Primary = doc.Payload.RateLimits.Primary
		ev.Limits.Secondary = doc.Payload.RateLimits.Secondary
		found = ev
	}
	return found
}

// recentRollouts lista los archivos de sesión más nuevos, del más reciente al
// más viejo.
func recentRollouts(root string, max int) []string {
	type entry struct {
		path string
		mod  time.Time
	}
	var all []entry
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".jsonl") {
			return nil
		}
		info, ierr := d.Info()
		if ierr != nil {
			return nil
		}
		all = append(all, entry{path, info.ModTime()})
		return nil
	})
	sort.Slice(all, func(i, j int) bool { return all[i].mod.After(all[j].mod) })
	out := []string{}
	for i := 0; i < len(all) && i < max; i++ {
		out = append(out, all[i].path)
	}
	return out
}

// antigravityLimits informa que este dato no existe en el disco.
//
// Es la misma decisión que ya toma agentplan: no saber y "0% usado" son cosas
// distintas, y mostrarlas igual sería inventar el número más peligroso de esta
// pantalla — el que dice que te queda cuota.
func antigravityLimits(home string) AgentLimits {
	l := AgentLimits{Agent: "antigravity", Source: filepath.Join(home, ".gemini", "antigravity-cli")}
	if _, err := os.Stat(l.Source); err != nil {
		l.Note = "No se encontró Antigravity CLI en esta máquina."
		return l
	}
	// No hay nada en el disco, pero sí se le puede preguntar a él: `agy --print
	// "/usage"` corre el mismo slash command sin abrir la TUI. Se ofrece como
	// botón y no se dispara solo — cuesta un subproceso y unos segundos. Ver
	// query.go.
	l.Queryable = true
	l.Note = "Antigravity no guarda su cuota en el disco. Se le puede preguntar a él mismo: tarda unos segundos y no consume cuota."
	return l
}
