package agentusage

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Lector de los transcripts de Claude Code. Es el único de los tres que está
// verificado contra archivos reales (ver el doc del paquete).

// maxLineBytes acota una línea del transcript. Una línea lleva un mensaje
// entero, y con contenido pegado puede ser grande — pero una de 8 MB significa
// que esto no es lo que creemos que es.
const maxLineBytes = 8 << 20

// entry es lo que se lee de cada línea. Todo lo demás del evento se ignora:
// el transcript lleva el contenido completo de la conversación y acá solo
// interesan los contadores.
type entry struct {
	Type      string `json:"type"`
	Timestamp string `json:"timestamp"`
	Message   struct {
		ID    string `json:"id"`
		Model string `json:"model"`
		Usage struct {
			Input      int64 `json:"input_tokens"`
			Output     int64 `json:"output_tokens"`
			CacheWrite int64 `json:"cache_creation_input_tokens"`
			CacheRead  int64 `json:"cache_read_input_tokens"`
		} `json:"usage"`
	} `json:"message"`
}

// readClaude recorre ~/.claude/projects y agrega el consumo.
//
// repoSlug es el directorio que le corresponde al repositorio abierto, o ""
// si no se pudo calcular; sirve para separar "lo de este repo" del total.
func readClaude(home, repoSlug string, since time.Time) AgentUsage {
	root := filepath.Join(home, ".claude", "projects")
	u := AgentUsage{Agent: "claude", Source: root}

	dirs, err := os.ReadDir(root)
	if err != nil {
		u.Note = "No hay transcripts de Claude Code en esta máquina."
		return u
	}

	byModel := map[string]*Bucket{}
	byDay := map[string]*Bucket{}
	// Un mismo mensaje aparece repetido en el transcript (reintentos, ramas de
	// la conversación, sidechains). Sumarlo dos veces inflaría el total sin
	// que se note, así que se cuenta una sola vez por id de mensaje.
	seen := map[string]bool{}

	for _, d := range dirs {
		if !d.IsDir() {
			continue
		}
		isRepo := repoSlug != "" && d.Name() == repoSlug
		dir := filepath.Join(root, d.Name())

		files, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, f := range files {
			if f.IsDir() || !strings.EqualFold(filepath.Ext(f.Name()), ".jsonl") {
				continue
			}
			// El mtime del archivo descarta sesiones viejas sin abrirlas: es
			// la diferencia entre leer una semana y leer todo el historial.
			if info, err := f.Info(); err == nil && info.ModTime().Before(since) {
				continue
			}
			scanFile(filepath.Join(dir, f.Name()), since, seen, isRepo, &u, byModel, byDay)
		}
	}

	u.Available = u.All.Messages > 0
	if !u.Available {
		u.Note = "Claude Code no registró consumo en el período leído."
		return u
	}

	u.ByModel = finish(byModel, u.All.Total, 0)
	// Los días vienen ordenados por fecha y no por consumo: lo que se lee en
	// una serie temporal es la tendencia, y ordenarla por magnitud la
	// destruye.
	u.ByDay = finish(byDay, u.All.Total, 0)
	sortByKey(u.ByDay)
	if len(u.ByDay) > 0 {
		u.FirstDay, u.LastDay = u.ByDay[0].Key, u.ByDay[len(u.ByDay)-1].Key
	}

	if in := u.All.Input + u.All.CacheRead + u.All.CacheWrite; in > 0 {
		u.CacheHitPercent = round1(float64(u.All.CacheRead) / float64(in) * 100)
	}
	return u
}

func scanFile(path string, since time.Time, seen map[string]bool, isRepo bool, u *AgentUsage, byModel, byDay map[string]*Bucket) {
	fh, err := os.Open(path)
	if err != nil {
		return
	}
	defer fh.Close()

	sc := bufio.NewScanner(fh)
	sc.Buffer(make([]byte, 0, 64*1024), maxLineBytes)

	for sc.Scan() {
		line := sc.Bytes()
		// Filtro barato antes de parsear: la enorme mayoría de las líneas son
		// mensajes del usuario o resultados de herramientas, sin contadores.
		if !strings.Contains(string(line), `"usage"`) {
			continue
		}

		var e entry
		if err := json.Unmarshal(line, &e); err != nil {
			continue // una línea rota no invalida el archivo
		}
		usage := e.Message.Usage
		total := usage.Input + usage.Output + usage.CacheWrite + usage.CacheRead
		if total == 0 {
			continue
		}
		if e.Message.ID != "" {
			if seen[e.Message.ID] {
				continue
			}
			seen[e.Message.ID] = true
		}

		day := ""
		if ts, err := time.Parse(time.RFC3339, e.Timestamp); err == nil {
			if ts.Before(since) {
				continue
			}
			day = ts.Local().Format("2006-01-02")
		}

		add(&u.All, usage.Input, usage.Output, usage.CacheWrite, usage.CacheRead)
		if isRepo {
			add(&u.Repo, usage.Input, usage.Output, usage.CacheWrite, usage.CacheRead)
		}

		model := e.Message.Model
		if model == "" {
			model = "desconocido"
		}
		bump(byModel, model, total)
		if day != "" {
			bump(byDay, day, total)
		}
	}
}

func add(t *Totals, in, out, cw, cr int64) {
	t.Input += in
	t.Output += out
	t.CacheWrite += cw
	t.CacheRead += cr
	t.Total += in + out + cw + cr
	t.Messages++
}

func bump(m map[string]*Bucket, key string, total int64) {
	b, ok := m[key]
	if !ok {
		b = &Bucket{Key: key}
		m[key] = b
	}
	b.Total += total
	b.Messages++
}

// finish convierte el mapa en una lista con porcentajes, ordenada de mayor a
// menor. limit 0 devuelve todo.
func finish(m map[string]*Bucket, total int64, limit int) []Bucket {
	out := make([]Bucket, 0, len(m))
	for _, b := range m {
		if total > 0 {
			b.Percent = round1(float64(b.Total) / float64(total) * 100)
		}
		out = append(out, *b)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Total > out[j].Total })
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

// sortByKey ordena los buckets por su clave. Se usa para las series por día:
// lo que se lee en una serie temporal es la tendencia, y ordenarla por
// magnitud la destruye.
func sortByKey(list []Bucket) {
	sort.Slice(list, func(i, j int) bool { return list[i].Key < list[j].Key })
}

func round1(v float64) float64 {
	return float64(int(v*10+0.5)) / 10
}

// claudeSlug traduce la ruta de un proyecto al nombre del directorio que usa
// Claude Code: la ruta absoluta con "/", "_" y "." reemplazados por "-".
//
// Es lo que permite decir "de esto, tanto se consumió en ESTE repositorio".
// Verificado contra los directorios reales de ~/.claude/projects.
func claudeSlug(repoRoot string) string {
	if repoRoot == "" {
		return ""
	}
	abs, err := filepath.Abs(repoRoot)
	if err != nil {
		abs = repoRoot
	}
	r := strings.NewReplacer("/", "-", "\\", "-", "_", "-", ".", "-")
	return r.Replace(abs)
}
