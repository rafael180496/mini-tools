package agentusage

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"strconv"
	"time"

	"mini-tools/backend/agents"
	"mini-tools/backend/i18n"
)

// OpenCode.
//
// # Qué se comprobó, con OpenCode 2.0.22 instalado
//
// OpenCode guarda sus sesiones en una base SQLite propia
// (`~/.local/share/opencode/opencode.db`). Leerla directo ataría este paquete
// a su esquema interno, y no hace falta: `opencode stats --json` es la interfaz
// que el CLI publica para esto y ya devuelve los contadores agregados.
//
//	opencode stats --standalone --days 30 --models --json            (la máquina)
//	opencode stats --standalone --days 30 --models --json --project . (el repo)
//
// Del JSON se usan `tokens` (`input`, `output`, `reasoning`, `cache.read`,
// `cache.write`), `steps`, `activity[{date,steps}]` y `models[]` (cada uno con
// `model.{id,providerID,variant}`, `steps` y sus propios `tokens`). Fixtures
// reales en testdata/opencode-stats-*.json.
//
// # Cómo se mapean los contadores, para que se comparen con Claude Code
//
// Claude Code reporta cuatro clases que NO se pisan entre sí: `input_tokens`
// (sin caché), `output_tokens`, escritura de caché y lectura de caché, y el
// total es la suma de las cuatro. OpenCode usa la misma partición, con dos
// diferencias que se comprobaron contra los números reales:
//
//   - **`input` no incluye lo leído de la caché ni lo escrito en ella** (hay
//     modelos con `input: 681` y `cache.write: 692698`: si la escritura
//     estuviera adentro, `input` no podría ser menor). Entra tal cual.
//   - **`reasoning` va aparte de `output`** (`output: 36208`, `reasoning:
//     39413`: no puede ser un subconjunto). En Claude Code el razonamiento ya
//     está dentro de `output_tokens`, así que acá se SUMA a la salida; si no,
//     un modelo que piensa mucho parecería gastar la mitad.
//
// Por eso: Input=input, Output=output+reasoning, CacheWrite=cache.write,
// CacheRead=cache.read, Total=la suma de las cuatro. `Messages` son los pasos
// (`steps`): cada uno es una llamada al modelo, el equivalente de un mensaje
// del asistente en el transcript de Claude Code.
//
// # Lo que NO hay: tokens por día
//
// `activity` trae solo PASOS por día, no tokens. Mezclarlos en `ByDay` —cuyo
// `Total` son tokens en los otros agentes— dibujaría una serie en otra unidad
// con la misma escala, así que `ByDay` queda vacío. El período se acota igual
// con la primera y la última fecha de `activity` (FirstDay/LastDay).
//
// # Detalles de la ejecución
//
//   - OpenCode toma el directorio de trabajo de la variable `PWD`, no del cwd
//     real del proceso: se fijan las dos (ver agentchat/opencode.go, donde se
//     encontró).
//   - `--standalone` siempre: sin eso habla con un servicio en segundo plano
//     que ya arrancó con otro entorno.
//   - Sin repositorio, `Repo` queda vacío. Un directorio que no es proyecto de
//     OpenCode da cero sesiones, no un error.

// opencodeStatsTimeout acota cada consulta. Es una lectura local que tarda una
// fracción de segundo; si tarda más, algo está mal y el panel no puede esperar.
const opencodeStatsTimeout = 20 * time.Second

// opencodeStatsRunner devuelve el JSON de `opencode stats`. Es una variable de
// tipo función para poder probar todo el lector sin el CLI instalado.
type opencodeStatsRunner func(ctx context.Context, bin, dir string, days int, project bool) ([]byte, error)

// runOpencodeStats lanza el CLI real.
func runOpencodeStats(ctx context.Context, bin, dir string, days int, project bool) ([]byte, error) {
	argv := agents.Launcher(bin)
	args := append(append([]string{}, argv[1:]...), "stats", "--standalone", "--days", strconv.Itoa(days), "--models", "--json")
	if project {
		args = append(args, "--project", ".")
	}
	cmd := exec.CommandContext(ctx, argv[0], args...)
	cmd.Dir = dir
	cmd.Env = agents.Env("PWD=" + dir)
	return cmd.Output()
}

// opencodeStats es lo que se lee del JSON. Solo los campos que se usan.
type opencodeStats struct {
	Sessions int            `json:"sessions"`
	Steps    int            `json:"steps"`
	Tokens   opencodeTokens `json:"tokens"`
	Activity []struct {
		Date  string `json:"date"`
		Steps int    `json:"steps"`
	} `json:"activity"`
	Models []struct {
		Model struct {
			ID         string `json:"id"`
			ProviderID string `json:"providerID"`
		} `json:"model"`
		Steps  int            `json:"steps"`
		Tokens opencodeTokens `json:"tokens"`
	} `json:"models"`
}

type opencodeTokens struct {
	Input     int64 `json:"input"`
	Output    int64 `json:"output"`
	Reasoning int64 `json:"reasoning"`
	Cache     struct {
		Read  int64 `json:"read"`
		Write int64 `json:"write"`
	} `json:"cache"`
}

// totals traduce los contadores de OpenCode a las cuatro clases del paquete.
// Ver el encabezado del archivo para el porqué de cada línea.
func (t opencodeTokens) totals(steps int) Totals {
	out := t.Output + t.Reasoning
	return Totals{
		Input:      t.Input,
		Output:     out,
		CacheWrite: t.Cache.Write,
		CacheRead:  t.Cache.Read,
		Total:      t.Input + out + t.Cache.Write + t.Cache.Read,
		Messages:   steps,
	}
}

// parseOpencodeStats lee la salida de `opencode stats --json`. Es la parte
// pura de este lector: no ejecuta nada.
func parseOpencodeStats(raw []byte) (opencodeStats, error) {
	var s opencodeStats
	err := json.Unmarshal(raw, &s)
	return s, err
}

// applyOpencode vuelca las estadísticas en un AgentUsage. `repo` es nil cuando
// no hay repositorio o no se pudo consultar.
func applyOpencode(u *AgentUsage, all opencodeStats, repo *opencodeStats) {
	u.All = all.Tokens.totals(all.Steps)
	if repo != nil {
		u.Repo = repo.Tokens.totals(repo.Steps)
	}

	byModel := map[string]*Bucket{}
	unknown := i18n.T(i18n.Msg{ES: "desconocido", EN: "unknown"})
	for _, m := range all.Models {
		tot := m.Tokens.totals(m.Steps)
		// Un modelo con pasos pero sin tokens contados (un intento que falló
		// antes de responder) sería una fila al 0% sin nada que comparar.
		if tot.Total == 0 {
			continue
		}
		key := m.Model.ID
		if key == "" {
			key = unknown
		} else if m.Model.ProviderID != "" {
			key = m.Model.ProviderID + "/" + key
		}
		// El mismo modelo aparece una vez por variante (`medium`, `default`):
		// para quien mira el reparto es un solo modelo.
		b, ok := byModel[key]
		if !ok {
			b = &Bucket{Key: key}
			byModel[key] = b
		}
		b.Total += tot.Total
		b.Messages += m.Steps
	}
	u.ByModel = finish(byModel, u.All.Total, 0)

	// Los días salen de la actividad y solo acotan el período; ver "Lo que NO
	// hay" en el encabezado. `activity` viene ordenada, pero no se depende de
	// eso.
	for _, a := range all.Activity {
		if a.Steps <= 0 || a.Date == "" {
			continue
		}
		if u.FirstDay == "" || a.Date < u.FirstDay {
			u.FirstDay = a.Date
		}
		if a.Date > u.LastDay {
			u.LastDay = a.Date
		}
	}

	if in := u.All.Input + u.All.CacheRead + u.All.CacheWrite; in > 0 {
		u.CacheHitPercent = round1(float64(u.All.CacheRead) / float64(in) * 100)
	}
}

// readOpencode consulta al propio CLI el consumo de los últimos `days` días.
func readOpencode(repoRoot string, days int) AgentUsage {
	return readOpencodeWith(repoRoot, days, agents.Resolve("opencode"), runOpencodeStats)
}

func readOpencodeWith(repoRoot string, days int, bin string, run opencodeStatsRunner) AgentUsage {
	u := AgentUsage{Agent: "opencode", Source: "opencode stats --days " + strconv.Itoa(days)}

	if bin == "" {
		u.Note = i18n.T(i18n.Msg{ES: "No se encontró OpenCode CLI en esta máquina.", EN: "OpenCode CLI was not found on this machine."})
		return u
	}

	// Sin repositorio las estadísticas de la máquina no dependen del
	// directorio, pero OpenCode necesita uno que exista.
	dir := repoRoot
	if dir == "" {
		dir, _ = os.UserHomeDir()
	}

	ctx, cancel := context.WithTimeout(context.Background(), opencodeStatsTimeout)
	defer cancel()

	raw, err := run(ctx, bin, dir, days, false)
	if err != nil {
		u.Note = i18n.T(i18n.Msg{ES: "OpenCode no pudo informar su consumo (¿está instalado y con sesiones?).", EN: "OpenCode could not report its usage (is it installed and has it any sessions?)."})
		return u
	}
	all, err := parseOpencodeStats(raw)
	if err != nil {
		// Un formato distinto del esperado NO se reporta como "sin consumo":
		// decirlo es lo que permite darse cuenta de que hay que actualizar
		// esto en vez de mostrar un cero que parece un dato.
		u.Note = i18n.T(i18n.Msg{ES: "OpenCode devolvió estadísticas con un formato que esta versión no sabe leer.", EN: "OpenCode returned statistics in a format this version cannot read."})
		return u
	}

	var repo *opencodeStats
	if repoRoot != "" {
		// Una falla acá no invalida el total de la máquina: solo deja el
		// repositorio en cero.
		if raw, err := run(ctx, bin, repoRoot, days, true); err == nil {
			if s, err := parseOpencodeStats(raw); err == nil {
				repo = &s
			}
		}
	}

	applyOpencode(&u, all, repo)
	u.Available = u.All.Messages > 0 || u.All.Total > 0
	if !u.Available {
		u.Note = i18n.T(i18n.Msg{ES: "OpenCode no registró consumo en el período leído.", EN: "OpenCode recorded no usage in the period read."})
	}
	return u
}
